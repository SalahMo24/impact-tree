'use strict';
// Syntax-only caller resolution: no TypeScript Program, no type checker, no
// node_modules. Parses every source file with createSourceFile and resolves calls by
// (a) import + name for bare calls, and (b) the declared type of the receiver for
// member calls -- DI members carry explicit annotations in the constructor, which is
// syntax we can read without inference.
const fs = require('fs');
const path = require('path');

function createSyntacticIndex(ts, roots, { baseDirs = [] } = {}) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
      else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts')) files.push(p);
    }
  };
  roots.forEach(walk);

  const byFile = new Map();

  const typeNameOf = (typeNode, sf) => {
    if (!typeNode) return null;
    let t = typeNode;
    while (t && (ts.isArrayTypeNode(t))) t = t.elementType;
    if (!t) return null;
    if (ts.isTypeReferenceNode(t)) {
      const n = t.typeName;
      return ts.isQualifiedName(n) ? n.right.text : n.text;
    }
    return null;
  };

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true);
    const imports = new Map();     // localName -> { module, imported }
    const decls = new Map();       // exported/declared top-level name -> { kind, pos }
    const classes = new Map();     // className -> { members: Map<name,TypeName>, methods: Map<name,pos> }
    const calls = [];              // { name, receiver, pos, ownerClass, ownerLabel, ownerPos }

    const localTypes = new Map();  // variable name -> TypeName (annotation or `new Foo()`)
    const implementsEdges = [];    // { iface, cls }
    const handlerFor = new Map();  // className -> command class name (@CommandHandler(X))

    const recordImport = (node) => {
      const mod = node.moduleSpecifier && node.moduleSpecifier.text;
      if (!mod || !node.importClause) return;
      const c = node.importClause;
      if (c.name) imports.set(c.name.text, { module: mod, imported: 'default' });
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const el of c.namedBindings.elements) {
          imports.set(el.name.text, { module: mod, imported: (el.propertyName || el.name).text });
        }
      }
    };

    const enclosing = [];
    const ownerLabel = () => (enclosing.length ? enclosing[enclosing.length - 1] : null);

    const visit = (node, cls) => {
      let currentClass = cls;
      if (ts.isImportDeclaration(node)) { recordImport(node); return; }

      if (ts.isClassDeclaration(node) && node.name) {
        currentClass = node.name.text;
        // `class X implements IY` is the port -> adapter link, and it is plain syntax
        for (const h of node.heritageClauses || []) {
          if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const t of h.types) {
            const e2 = t.expression;
            if (ts.isIdentifier(e2)) implementsEdges.push({ iface: e2.text, cls: node.name.text });
          }
        }
        for (const d of ts.getDecorators(node) || []) {
          const de = d.expression;
          if (ts.isCallExpression(de) && /^(CommandHandler|QueryHandler|EventsHandler)$/.test(de.expression.getText(sf))) {
            const arg = de.arguments[0];
            if (arg && ts.isIdentifier(arg)) handlerFor.set(node.name.text, arg.text);
          }
        }
        const entry = { members: new Map(), methods: new Map() };
        classes.set(currentClass, entry);
        decls.set(currentClass, { kind: 'class', pos: node.name.getStart(sf) });
        for (const m of node.members) {
          if (ts.isConstructorDeclaration(m)) {
            for (const p of m.parameters) {
              const tn = typeNameOf(p.type, sf);
              if (tn && ts.isIdentifier(p.name)) entry.members.set(p.name.text, tn);
            }
          } else if (ts.isPropertyDeclaration(m) && m.name) {
            const tn = typeNameOf(m.type, sf);
            if (tn) entry.members.set(m.name.getText(sf), tn);
          }
          if ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) && m.name) {
            entry.methods.set(m.name.getText(sf), m.name.getStart(sf));
          }
        }
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        decls.set(node.name.text, { kind: 'function', pos: node.name.getStart(sf) });
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const tn = typeNameOf(node.type, sf)
          || (node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
            ? node.initializer.expression.text : null);
        if (tn) localTypes.set(node.name.text, tn);
        if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          decls.set(node.name.text, { kind: 'function', pos: node.name.getStart(sf) });
        }
      }

      // track the enclosing named callable so a call can be attributed to its owner
      let pushed = false;
      const nameNode = (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) ? node.name : null;
      if (nameNode) {
        enclosing.push({ label: currentClass ? `${currentClass}.${nameNode.getText(sf)}` : nameNode.getText(sf), pos: nameNode.getStart(sf) });
        pushed = true;
      } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
        // Only adopt the variable's name when the arrow IS the initializer. For
        // `const result = await tx(async () => ...)` the variable holds the RESULT,
        // not the function, so attributing calls to `result` invents a caller and
        // hides the real enclosing method.
        const vd = ts.findAncestor(node, (a) => ts.isVariableDeclaration(a));
        if (vd && vd.initializer === node && vd.name && ts.isIdentifier(vd.name)) {
          // NOT qualified with the class: the TS call hierarchy labels a nested arrow by
          // its bare variable name, and qualifying it cost 5 points of recall.
          enclosing.push({ label: vd.name.text, pos: vd.name.getStart(sf) });
          pushed = true;
        }
      }

      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        calls.push({
          name: 'constructor', receiver: { kind: 'new', typeName: node.expression.text },
          pos: node.expression.getStart(sf), ownerClass: currentClass, owner: ownerLabel(),
        });
      }
      if (ts.isCallExpression(node)) {
        const e = node.expression;
        const owner = ownerLabel();
        if (ts.isIdentifier(e)) {
          calls.push({ name: e.text, receiver: null, pos: e.getStart(sf), ownerClass: currentClass, owner });
        } else if (ts.isPropertyAccessExpression(e)) {
          const recv = e.expression;
          let receiver = null;
          if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword) {
            receiver = { kind: 'thisMember', name: recv.name.text };
          } else if (ts.isIdentifier(recv)) {
            receiver = { kind: 'ident', name: recv.text };
          } else if (recv.kind === ts.SyntaxKind.ThisKeyword) {
            receiver = { kind: 'this' };
          }
          calls.push({ name: e.name.text, receiver, pos: e.name.getStart(sf), ownerClass: currentClass, owner });
        }
      }

      ts.forEachChild(node, (k) => visit(k, currentClass));
      if (pushed) enclosing.pop();
    };
    ts.forEachChild(sf, (k) => visit(k, undefined));

    byFile.set(file, { file, imports, decls, classes, calls, localTypes, implementsEdges, handlerFor });
  }

  // --- module resolution, syntactic only -------------------------------------
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const resolveModule = (fromFile, spec) => {
    const tryPaths = [];
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(fromFile), spec);
      tryPaths.push(`${base}.ts`, path.join(base, 'index.ts'));
    } else {
      for (const bd of baseDirs) {
        const base = path.join(bd, spec);
        tryPaths.push(`${base}.ts`, path.join(base, 'index.ts'));
      }
    }
    return tryPaths.find(exists) || null;
  };

  const implementedBy = new Map();   // interfaceName -> Set<className>
  const handlerCommand = new Map();  // className -> command class name
  for (const rec of byFile.values()) {
    for (const e of rec.implementsEdges) {
      if (!implementedBy.has(e.iface)) implementedBy.set(e.iface, new Set());
      implementedBy.get(e.iface).add(e.cls);
    }
    for (const [cls, cmd] of rec.handlerFor) handlerCommand.set(cls, cmd);
  }

  // name -> files that declare it (fallback when a module cannot be resolved)
  const declIndex = new Map();
  for (const rec of byFile.values()) {
    for (const name of rec.decls.keys()) {
      if (!declIndex.has(name)) declIndex.set(name, []);
      declIndex.get(name).push(rec.file);
    }
  }

  const declaringFileFor = (rec, name) => {
    if (rec.decls.has(name)) return rec.file;
    const imp = rec.imports.get(name);
    if (imp) {
      const f = resolveModule(rec.file, imp.module);
      if (f) return f;
    }
    const cands = declIndex.get(name);
    return cands && cands.length === 1 ? cands[0] : null;   // unique name = safe fallback
  };

  // --- reverse lookup ---------------------------------------------------------
  // target: { file, className, name }  ->  [{ file, label, pos }]
  function callersOf(target) {
    const out = new Map();
    // a member typed as the port resolves to the adapter that implements it
    const typeMatches = (typeName) => typeName === target.className
      || (implementedBy.get(typeName) || new Set()).has(target.className);
    // a CQRS handler's execute() is reached by constructing its command
    const command = target.className && target.name === 'execute' ? handlerCommand.get(target.className) : null;
    for (const rec of byFile.values()) {
      for (const c of rec.calls) {
        if (command && c.receiver && c.receiver.kind === 'new' && c.receiver.typeName === command) {
          if (c.owner) {
            const id2 = `${rec.file}#${c.owner.pos}`;
            if (!out.has(id2)) out.set(id2, { file: rec.file, label: c.owner.label, pos: c.owner.pos, via: 'cqrs' });
          }
          continue;
        }
        if (c.name !== target.name) continue;
        let ok = false;
        if (c.receiver && c.receiver.kind === 'new') {
          ok = target.name === 'constructor' && typeMatches(c.receiver.typeName);
        } else if (!c.receiver) {
          ok = !target.className && declaringFileFor(rec, c.name) === target.file;
        } else if (c.receiver.kind === 'this') {
          ok = !!target.className && c.ownerClass === target.className && rec.file === target.file;
        } else {
          const typeName = c.receiver.kind === 'thisMember'
            ? (rec.classes.get(c.ownerClass) || { members: new Map() }).members.get(c.receiver.name)
            : rec.localTypes.get(c.receiver.name);
          if (typeName && typeMatches(typeName)) {
            const declFile = declaringFileFor(rec, typeName);
            ok = !declFile || declFile === target.file;
          }
        }
        if (!ok || !c.owner) continue;
        const id = `${rec.file}#${c.owner.pos}`;
        if (!out.has(id)) out.set(id, { file: rec.file, label: c.owner.label, pos: c.owner.pos });
      }
    }
    return [...out.values()];
  }

  return { files, byFile, callersOf, resolveModule, implementedBy, handlerCommand, size: byFile.size };
}
module.exports = { createSyntacticIndex };
