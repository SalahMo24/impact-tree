'use strict';
// Syntax-only caller resolution: no TypeScript Program, no type checker, no
// node_modules. Parses each source with createSourceFile and resolves calls by
// (a) import + name for bare calls, and (b) the declared type of the receiver for
// member calls -- DI members carry explicit annotations in the constructor, which is
// syntax we can read without inference.
//
// It takes a flat set of {path, text} rather than walking the disk, so the SAME code
// serves a checked-out repo and a set of files fetched from the GitHub API. That is
// the whole point of Tier A: review a PR without touching the worktree.
const path = require('path');

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function scriptKindOf(ts, file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function createSyntacticIndex(ts, sources, { baseDirs = [], tsPaths = null, pathsBase = null } = {}) {
  const byFile = new Map();
  const texts = new Map();

  const typeNameOf = (typeNode) => {
    if (!typeNode) return null;
    let t = typeNode;
    while (t && ts.isArrayTypeNode(t)) t = t.elementType;
    // `Foo | undefined` unwraps to Foo; anything more ambiguous stays unresolved
    if (t && ts.isUnionTypeNode(t)) {
      const named = t.types.filter((x) => ts.isTypeReferenceNode(x));
      if (named.length !== 1) return null;
      t = named[0];
    }
    if (!t || !ts.isTypeReferenceNode(t)) return null;
    const n = t.typeName;
    const name = ts.isQualifiedName(n) ? n.right.text : n.text;
    if (/^(Promise|Array|Readonly|Partial)$/.test(name) && t.typeArguments && t.typeArguments.length === 1) {
      return typeNameOf(t.typeArguments[0]);
    }
    return name;
  };

  for (const src of sources) {
    const file = src.path;
    const text = src.text;
    if (typeof text !== 'string') continue;
    texts.set(file, text);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true, scriptKindOf(ts, file));

    const imports = new Map();     // localName -> { module, imported }
    const decls = new Map();       // declared top-level name -> { kind, pos }
    const classes = new Map();     // className -> { members, methods }
    const calls = [];
    const localTypes = new Map();
    const implementsEdges = [];    // { iface, cls }
    const extendsEdges = [];       // { parent, child } for classes and interfaces alike
    const handlerFor = new Map();
    const reExports = [];          // `export * from './x'` / `export { a } from './x'`

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
    // A call at module scope -- `const x = target()` at the top of a file -- has no
    // enclosing callable. Returning null for its owner dropped the edge entirely,
    // so a real dependency simply vanished. Attribute it to the module instead,
    // which is also what the TypeScript call hierarchy does.
    const moduleOwner = { label: path.basename(file), pos: 0, module: true };
    const ownerLabel = () => (enclosing.length ? enclosing[enclosing.length - 1] : moduleOwner);

    const visit = (node, cls) => {
      let currentClass = cls;
      if (ts.isImportDeclaration(node)) { recordImport(node); return; }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        // A barrel re-export is why `import { X } from '../index'` resolves to a file
        // that does not declare X. Following it is pure syntax.
        reExports.push({
          module: node.moduleSpecifier.text,
          names: node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map((el) => el.name.text) : null,   // null = export *
        });
        return;
      }

      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
        const isClass = ts.isClassDeclaration(node);
        currentClass = isClass ? node.name.text : currentClass;
        for (const h of node.heritageClauses || []) {
          for (const t of h.types) {
            const e2 = t.expression;
            if (!ts.isIdentifier(e2)) continue;
            if (h.token === ts.SyntaxKind.ImplementsKeyword) implementsEdges.push({ iface: e2.text, cls: node.name.text });
            else extendsEdges.push({ parent: e2.text, child: node.name.text });
          }
        }
        for (const d of (ts.getDecorators ? ts.getDecorators(node) : node.decorators) || []) {
          const de = d.expression;
          if (ts.isCallExpression(de) && /^(CommandHandler|QueryHandler|EventsHandler)$/.test(de.expression.getText(sf))) {
            const arg = de.arguments[0];
            if (arg && ts.isIdentifier(arg)) handlerFor.set(node.name.text, arg.text);
          }
        }
        const entry = classes.get(node.name.text) || { members: new Map(), methods: new Map() };
        classes.set(node.name.text, entry);
        decls.set(node.name.text, { kind: isClass ? 'class' : 'interface', pos: node.name.getStart(sf) });
        for (const m of node.members) {
          if (ts.isConstructorDeclaration(m)) {
            for (const p of m.parameters) {
              const tn = typeNameOf(p.type);
              if (tn && ts.isIdentifier(p.name)) entry.members.set(p.name.text, tn);
            }
          } else if (ts.isPropertyDeclaration(m) && m.name) {
            const tn = typeNameOf(m.type)
              || (m.initializer && ts.isNewExpression(m.initializer) && ts.isIdentifier(m.initializer.expression)
                ? m.initializer.expression.text : null);
            if (tn) entry.members.set(m.name.getText(sf), tn);
          } else if (ts.isPropertySignature(m) && m.name) {
            const tn = typeNameOf(m.type);
            if (tn) entry.members.set(m.name.getText(sf), tn);
          }
          if ((ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isGetAccessorDeclaration(m)) && m.name) {
            entry.methods.set(m.name.getText(sf), m.name.getStart(sf));
          }
        }
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        decls.set(node.name.text, { kind: 'function', pos: node.name.getStart(sf) });
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const tn = typeNameOf(node.type)
          || (node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
            ? node.initializer.expression.text : null);
        if (tn) localTypes.set(node.name.text, tn);
        if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          decls.set(node.name.text, { kind: 'function', pos: node.name.getStart(sf) });
        }
      }
      // a typed parameter is as good as a typed member for receiver resolution
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const tn = typeNameOf(node.type);
        if (tn) localTypes.set(node.name.text, tn);
      }

      let pushed = false;
      const nameNode = (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) ? node.name : null;
      if (nameNode) {
        enclosing.push({ label: currentClass ? `${currentClass}.${nameNode.getText(sf)}` : nameNode.getText(sf), pos: nameNode.getStart(sf) });
        pushed = true;
      } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        // Only adopt the variable's name when the arrow IS the initializer. For
        // `const result = await tx(async () => ...)` the variable holds the RESULT,
        // not the function, so attributing calls to `result` invents a caller.
        const vd = ts.findAncestor(node, (a) => ts.isVariableDeclaration(a));
        if (vd && vd.initializer === node && vd.name && ts.isIdentifier(vd.name)) {
          // NOT qualified with the class: the TS call hierarchy labels a nested arrow
          // by its bare variable name, and qualifying it cost 5 points of recall.
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
          } else {
            // A receiver we cannot classify -- `a.b().filter(...)`, an array literal,
            // an await. This MUST NOT stay null: null means "bare call, no receiver",
            // and conflating the two let `xs.map(..).filter(..)` match a top-level
            // function named `filter`. Chained calls are everywhere in React code and
            // nowhere in `this.x.y()` service code, so it only showed up off the
            // tuning set.
            receiver = { kind: 'unknown' };
          }
          calls.push({ name: e.name.text, receiver, pos: e.name.getStart(sf), ownerClass: currentClass, owner });
        }
      }

      ts.forEachChild(node, (k) => visit(k, currentClass));
      if (pushed) enclosing.pop();
    };
    ts.forEachChild(sf, (k) => visit(k, undefined));

    byFile.set(file, { file, imports, decls, classes, calls, localTypes, implementsEdges, extendsEdges, handlerFor, reExports });
  }

  // --- module resolution, syntactic only -------------------------------------
  const has = (p) => byFile.has(p);
  const tryExt = (base) => {
    for (const e of SOURCE_EXT) if (has(base + e)) return base + e;
    for (const e of SOURCE_EXT) if (has(path.join(base, 'index' + e))) return path.join(base, 'index' + e);
    return null;
  };
  // tsconfig `paths` is the biggest source of unresolved bare specifiers in a
  // monorepo -- `@app/foo` is not a package, it is a directory alias.
  const aliasCandidates = (spec) => {
    if (!tsPaths || !pathsBase) return [];
    const out = [];
    for (const [pattern, targets] of Object.entries(tsPaths)) {
      const star = pattern.indexOf('*');
      if (star === -1) { if (pattern === spec) targets.forEach((t) => out.push(path.resolve(pathsBase, t))); continue; }
      const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
      if (!spec.startsWith(pre) || !spec.endsWith(post)) continue;
      const mid = spec.slice(pre.length, spec.length - post.length);
      for (const t of targets) out.push(path.resolve(pathsBase, t.replace('*', mid)));
    }
    return out;
  };
  const resolveCache = new Map();
  const resolveModule = (fromFile, spec) => {
    const ck = `${fromFile} ${spec}`;
    if (resolveCache.has(ck)) return resolveCache.get(ck);
    let hit = null;
    if (spec.startsWith('.')) {
      hit = tryExt(path.resolve(path.dirname(fromFile), spec));
    } else {
      for (const c of aliasCandidates(spec)) { hit = tryExt(c); if (hit) break; }
      if (!hit) for (const bd of baseDirs) { hit = tryExt(path.join(bd, spec)); if (hit) break; }
    }
    resolveCache.set(ck, hit);
    return hit;
  };

  // --- type lattice ----------------------------------------------------------
  // A member declared as the PORT must match the ADAPTER that implements it, and a
  // method declared on a BASE class must match a call made through a SUBCLASS.
  const childrenOf = new Map();
  const parentsOf = new Map();
  const link = (parent, child) => {
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
    childrenOf.get(parent).add(child);
    if (!parentsOf.has(child)) parentsOf.set(child, new Set());
    parentsOf.get(child).add(parent);
  };
  const handlerCommand = new Map();
  for (const rec of byFile.values()) {
    for (const e of rec.implementsEdges) link(e.iface, e.cls);
    for (const e of rec.extendsEdges) link(e.parent, e.child);
    for (const [cls, cmd] of rec.handlerFor) handlerCommand.set(cls, cmd);
  }
  const closure = (start, table, cache) => {
    if (cache.has(start)) return cache.get(start);
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const n of table.get(cur) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    cache.set(start, seen);
    return seen;
  };
  const subCache = new Map();
  const superCache = new Map();
  const subtypesOf = (n) => closure(n, childrenOf, subCache);
  const supertypesOf = (n) => closure(n, parentsOf, superCache);

  // name -> files declaring it (fallback when a module cannot be resolved)
  const declIndex = new Map();
  for (const rec of byFile.values()) {
    for (const name of rec.decls.keys()) {
      if (!declIndex.has(name)) declIndex.set(name, []);
      declIndex.get(name).push(rec.file);
    }
  }

  const declaringFileFor = (rec, name, depth = 0) => {
    if (rec.decls.has(name)) return rec.file;
    const imp = rec.imports.get(name);
    if (imp) {
      const f = resolveModule(rec.file, imp.module);
      if (f) {
        const target = byFile.get(f);
        // follow barrel hops: index.ts rarely declares what it re-exports
        if (target && !target.decls.has(name) && depth < 3) {
          for (const re of target.reExports) {
            if (re.names && !re.names.includes(name)) continue;
            const f2 = resolveModule(target.file, re.module);
            if (!f2) continue;
            const r2 = byFile.get(f2);
            if (r2 && r2.decls.has(name)) return f2;
            const deeper = r2 ? declaringFileFor(r2, name, depth + 1) : null;
            if (deeper) return deeper;
          }
        }
        return f;
      }
      // The name is explicitly imported but the module is not in our file set. It is
      // therefore declared somewhere we do NOT hold -- never the target. Falling back
      // to a same-named local declaration here invents edges, which matters most in
      // Tier A where most imports point outside the fetched set.
      return null;
    }
    const cands = declIndex.get(name);
    return cands && cands.length === 1 ? cands[0] : null;   // unique name = safe fallback
  };

  // --- reverse lookup ---------------------------------------------------------
  // target: { file, className, name } -> [{ file, label, pos }]
  function callersOf(target) {
    const out = new Map();
    const subs = target.className ? subtypesOf(target.className) : new Set();
    const supers = target.className ? supertypesOf(target.className) : new Set();
    // A receiver typed as the port, as a supertype, or as any subtype can reach this.
    const typeMatches = (typeName) => typeName === target.className
      || subs.has(typeName) || supers.has(typeName);
    const command = target.className && target.name === 'execute' ? handlerCommand.get(target.className) : null;

    for (const rec of byFile.values()) {
      for (const c of rec.calls) {
        if (command && c.receiver && c.receiver.kind === 'new' && c.receiver.typeName === command) {
          if (c.owner) {
            const id2 = `${rec.file}#${c.owner.pos}`;
            if (!out.has(id2)) out.set(id2, { file: rec.file, label: c.owner.label, pos: c.owner.pos, via: 'cqrs', callSites: [] });
            out.get(id2).callSites.push({ start: c.pos, end: c.pos + String(c.name).length });
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
          if (c.ownerClass === target.className) ok = rec.file === target.file;
          // `this.foo()` in a subclass reaches a method declared on the base class
          else ok = !!target.className && supertypesOf(c.ownerClass || '').has(target.className);
        } else {
          const typeName = c.receiver.kind === 'thisMember'
            ? (rec.classes.get(c.ownerClass) || { members: new Map() }).members.get(c.receiver.name)
            : rec.localTypes.get(c.receiver.name);
          if (typeName && typeMatches(typeName)) {
            const declFile = declaringFileFor(rec, typeName);
            // A port and its adapter live in different files by design, so a file
            // mismatch only disqualifies a match on the target's OWN class name.
            ok = typeName !== target.className || !declFile || declFile === target.file;
          }
        }
        if (!ok || !c.owner) continue;
        const id = `${rec.file}#${c.owner.pos}`;
        if (!out.has(id)) out.set(id, { file: rec.file, label: c.owner.label, pos: c.owner.pos, callSites: [] });
        out.get(id).callSites.push({ start: c.pos, end: c.pos + String(c.name).length });
      }
    }
    return [...out.values()];
  }

  // (file, pos) -> { className, name } for a declaration, so a resolver can answer
  // incoming() with the same signature the rest of the engine already uses.
  const symbolIndex = new Map();
  for (const rec of byFile.values()) {
    for (const [cls, entry] of rec.classes) {
      for (const [m, pos] of entry.methods) symbolIndex.set(`${rec.file}#${pos}`, { className: cls, name: m });
    }
    for (const [name, d] of rec.decls) {
      if (d.kind === 'class') symbolIndex.set(`${rec.file}#${d.pos}`, { className: name, name: 'constructor' });
      else symbolIndex.set(`${rec.file}#${d.pos}`, { className: null, name });
    }
  }
  const symbolAt = (file, pos) => symbolIndex.get(`${file}#${pos}`) || null;

  return {
    byFile, texts, callersOf, symbolAt, resolveModule,
    subtypesOf, supertypesOf, handlerCommand, size: byFile.size,
  };
}

module.exports = { createSyntacticIndex, SOURCE_EXT };
