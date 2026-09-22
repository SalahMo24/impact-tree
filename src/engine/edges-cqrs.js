'use strict';
const fs = require('fs');

// A NestJS CQRS dispatch severs the static call graph: `bus.execute(new FooCommand())`
// resolves to CommandBus.execute, never to the @CommandHandler(FooCommand) that runs.
// In a large CQRS service that is hundreds of dispatch sites against hundreds of
// handlers, so without this every handler looks unreachable and reads as zero blast
// radius.
//
// Deps are injected so the same logic serves both resolvers: the CLI supplies the
// TypeScript LanguageService, the extension supplies VS Code's definition/reference
// providers (which reuse the editor's already-warm server).

const HANDLER_DECORATORS = /^@(CommandHandler|QueryHandler|EventsHandler)$/;

function makeCqrsEdges(ts, { definitionAt, referencesTo, isTestPath, trace = () => {} }) {
  const parsed = new Map();
  function sourceOf(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = parsed.get(file);
    if (hit && hit.key === key) return hit.sf;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true);
    parsed.set(file, { key, sf });
    return sf;
  }

  // The handler method -> the command class it handles, and where that class is named.
  function handledCommand(file, offset) {
    const sf = sourceOf(file);
    if (!sf) return null;
    let found = null;
    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.getStart(sf) <= offset && offset <= node.getEnd()) {
        for (const d of ts.getDecorators(node) || []) {
          const e = d.expression;
          if (!ts.isCallExpression(e)) continue;
          if (!HANDLER_DECORATORS.test(`@${e.expression.getText(sf)}`)) continue;
          const arg = e.arguments[0];
          if (arg && ts.isIdentifier(arg)) found = { name: arg.text, pos: arg.getStart(sf) };
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return found;
  }

  // Is this reference actually a construction (`new FooCommand(...)`)? A bare type
  // annotation or an import is not a dispatch.
  function constructionAt(file, offset) {
    const sf = sourceOf(file);
    if (!sf) return null;
    let hit = null;
    const visit = (node) => {
      if (node.getStart(sf) <= offset && offset < node.getEnd()) {
        if (ts.isNewExpression(node)) hit = node;
        ts.forEachChild(node, visit);
      }
    };
    ts.forEachChild(sf, visit);
    return hit;
  }

  // Innermost *named* callable. An arrow inside a method must report the method:
  // "SomeOrchestrator.(anonymous)" tells a reviewer nothing.
  function enclosingCallable(file, offset) {
    const sf = sourceOf(file);
    if (!sf) return null;
    const candidates = [];
    const visit = (node, cls) => {
      let c = cls;
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) c = node.name.text;
      const isFn = ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node);
      if (isFn && node.getStart(sf) <= offset && offset <= node.getEnd()) {
        let nameNode = ts.isConstructorDeclaration(node) ? node.getFirstToken(sf) : node.name;
        if (!nameNode && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
          const vd = ts.findAncestor(node, (a) => ts.isVariableDeclaration(a) || ts.isPropertyDeclaration(a) || ts.isPropertyAssignment(a));
          if (vd && vd.name) nameNode = vd.name;
        }
        candidates.push({
          named: !!nameNode,
          label: nameNode ? (c ? `${c}.${nameNode.getText(sf)}` : nameNode.getText(sf)) : null,
          span: node.getEnd() - node.getStart(sf),
          pos: (nameNode || node).getStart(sf),
        });
      }
      ts.forEachChild(node, (k) => visit(k, c));
    };
    ts.forEachChild(sf, (k) => visit(k, undefined));
    const named = candidates.filter((x) => x.named).sort((a, b) => a.span - b.span);
    if (named.length) return named[0];
    const any = candidates.sort((a, b) => a.span - b.span)[0];
    return any ? { ...any, label: `(top level) ${require('path').basename(file)}` } : null;
  }

  return {
    name: 'cqrs',
    // extra incoming edges for a handler's execute(): the dispatch sites of its command
    async extraCallers(file, offset) {
      const cmd = handledCommand(file, offset);
      if (!cmd) return [];
      const def = await definitionAt(file, cmd.pos);
      if (!def) { trace(`cqrs ${cmd.name}: definitionAt returned nothing`); return []; }
      const refs = await referencesTo(def.file, def.offset);
      trace(`cqrs ${cmd.name}: def ${require('path').basename(def.file)}@${def.offset}, ${refs.length} reference(s)`);
      const out = new Map();
      let notCtor = 0;
      for (const ref of refs) {
        const ctor = constructionAt(ref.file, ref.offset);
        if (!ctor) { notCtor++; continue; }
        const owner = enclosingCallable(ref.file, ref.offset);
        if (!owner) continue;
        const id = `${ref.file}#${owner.pos}`;
        const entry = out.get(id) || {
          label: owner.label, file: ref.file, pos: owner.pos,
          test: isTestPath(ref.file), sites: 0, callSites: [], via: 'cqrs', command: cmd.name,
        };
        entry.callSites.push({ start: ctor.getStart(), end: ctor.getEnd() });
        entry.sites = entry.callSites.length;
        out.set(id, entry);
      }
      trace(`cqrs ${cmd.name}: ${out.size} dispatch site(s), ${notCtor} reference(s) were not constructions`);
      return [...out.values()];
    },
    // `execute` on a handler resolves through ICommandHandler.execute, so the call
    // hierarchy hands back every bus.execute() site in the codebase -- 82 of them here.
    // None of them reach THIS handler. The dispatch sites are the only real callers.
    isHandlerExecute(file, offset) {
      const sf = sourceOf(file);
      if (!sf || !handledCommand(file, offset)) return false;
      let hit = false;
      const visit = (node) => {
        if (ts.isMethodDeclaration(node) && node.name && node.name.getText(sf) === 'execute') {
          const n = node.name;
          if (n.getStart(sf) <= offset && offset <= n.getEnd()) hit = true;
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(sf, visit);
      return hit;
    },
    _handledCommand: handledCommand,
  };
}
module.exports = { makeCqrsEdges };
