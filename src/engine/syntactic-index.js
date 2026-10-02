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

const slash = (p) => p.replace(/\\/g, '/');

function createSyntacticIndex(ts, sources, { baseDirs = [], tsPaths = null, pathsBase = null, moduleOptions = new Map(), packages = [] } = {}) {
  const byFile = new Map();
  const texts = new Map();

  const S = require('./symbols').makeSymbols(ts);
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
    const name = ts.isQualifiedName(n) ? n.getText() : n.text;
    if (/^(Promise|Array|Readonly|Partial)$/.test(name) && t.typeArguments && t.typeArguments.length === 1) {
      return typeNameOf(t.typeArguments[0]);
    }
    return name;
  };

  // TypeScript picks the `import` or `require` export condition from the importing file's
  // module format, and a `.ts` file's format comes from the nearest package.json `type`.
  // Ask TypeScript for both instead of guessing from the file extension.
  const manifests = new Map(packages.map((entry) => [slash(entry.dir), entry.data]));
  const manifestFor = (file) => (path.posix.basename(slash(file)) === 'package.json'
    ? manifests.get(path.posix.dirname(slash(file))) : undefined);
  const formatHost = {
    fileExists: (file) => manifestFor(file) !== undefined,
    readFile: (file) => { const data = manifestFor(file); return data === undefined ? undefined : JSON.stringify(data); },
  };
  const defaultOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext };
  const optionsFor = (file) => moduleOptions.get(file) || defaultOptions;
  const knowsFormats = typeof ts.getImpliedNodeFormatForFile === 'function' && typeof ts.getModeForUsageLocation === 'function';
  const parse = (file, text) => {
    if (!knowsFormats) return ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true, scriptKindOf(ts, file));
    const impliedNodeFormat = ts.getImpliedNodeFormatForFile(file, undefined, formatHost, optionsFor(file));
    return ts.createSourceFile(file, text, { languageVersion: ts.ScriptTarget.ES2021, impliedNodeFormat }, true, scriptKindOf(ts, file));
  };
  // `undefined` is a real answer: resolutions that ignore conditions, such as node10, have no mode.
  const modeAt = (sf, specifier) => (knowsFormats ? ts.getModeForUsageLocation(sf, specifier, optionsFor(sf.fileName)) : undefined);

  for (const src of sources) {
    const file = src.path;
    const text = src.text;
    if (typeof text !== 'string') continue;
    texts.set(file, text);
    const sf = parse(file, text);

    const imports = new Map();     // localName -> { module, imported }
    const bindingImports = new Map(); // require declaration -> import, including nested scopes
    const decls = new Map();       // declared top-level name -> { kind, pos }
    const classes = new Map();     // className -> { members, methods }
    const calls = [];
    const localTypes = new Map();
    const implementsEdges = [];    // { iface, cls }
    const extendsEdges = [];       // { parent, child } for classes and interfaces alike
    const handlerFor = new Map();
    const exports = new Map();
    const reExports = [];          // `export * from './x'` / `export { a } from './x'`

    const recordImport = (node) => {
      const mod = node.moduleSpecifier && node.moduleSpecifier.text;
      if (!mod || !node.importClause) return;
      const c = node.importClause;
      const mode = modeAt(sf, node.moduleSpecifier);
      if (c.name) imports.set(c.name.text, { module: mod, imported: 'default', mode });
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, { module: mod, imported: '*', mode });
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
        for (const el of c.namedBindings.elements) {
          imports.set(el.name.text, { module: mod, imported: (el.propertyName || el.name).text, mode });
        }
      }
    };

    const enclosing = [];
    // A call at module scope -- `const x = target()` at the top of a file -- has no
    // enclosing callable. Returning null for its owner dropped the edge entirely,
    // so a real dependency simply vanished. Attribute it to the module instead,
    // which is also what the TypeScript call hierarchy does.
    const moduleOwner = { label: path.basename(file), pos: 0, module: true };
    const staticContext = node => {
      for (let n = node.parent; n; n = n.parent) {
        if (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
          return ((ts.getModifiers ? ts.getModifiers(n) : n.modifiers) || []).some(m => m.kind === ts.SyntaxKind.StaticKeyword);
        }
        if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n)) return false;
      }
      return false;
    };
    const ownerLabel = () => (enclosing.length ? enclosing[enclosing.length - 1] : moduleOwner);

    const visit = (node, cls) => {
      let currentClass = cls;
      if (ts.isImportDeclaration(node)) { recordImport(node); return; }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        // A barrel re-export is why `import { X } from '../index'` resolves to a file
        // that does not declare X. Following it is pure syntax.
        reExports.push({
          module: node.moduleSpecifier.text,
          mode: modeAt(sf, node.moduleSpecifier),
          names: node.exportClause && ts.isNamedExports(node.exportClause)
            ? Object.fromEntries(node.exportClause.elements.map((el) => [el.name.text, (el.propertyName || el.name).text])) : null,   // null = export *
        });
        return;
      }

      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
        const isClass = ts.isClassDeclaration(node);
        currentClass = isClass ? node.name.text : currentClass;
        for (const h of node.heritageClauses || []) {
          for (const t of h.types) {
            const e2 = t.expression;
            if (!ts.isIdentifier(e2) && !ts.isPropertyAccessExpression(e2)) continue;
            if (h.token === ts.SyntaxKind.ImplementsKeyword) implementsEdges.push({ iface: e2.getText(sf), cls: node.name.text });
            else extendsEdges.push({ parent: e2.getText(sf), child: node.name.text });
          }
        }
        for (const d of (ts.getDecorators ? ts.getDecorators(node) : node.decorators) || []) {
          const de = d.expression;
          if (ts.isCallExpression(de) && /^(CommandHandler|QueryHandler|EventsHandler)$/.test(de.expression.getText(sf))) {
            const method = de.expression.getText(sf) === 'EventsHandler' ? 'handle' : 'execute';
            handlerFor.set(node.name.text, { method, commands: de.arguments.filter(ts.isIdentifier).map((a) => a.text) });
          }
        }
        const entry = classes.get(node.name.text) || { members: new Map(), methods: new Map(), staticMethods: new Set() };
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
            if (((ts.getModifiers ? ts.getModifiers(m) : m.modifiers) || []).some(x => x.kind === ts.SyntaxKind.StaticKeyword)) entry.staticMethods.add(m.name.getText(sf));
          }
        }
      }

      const modifiers = (ts.getModifiers ? ts.getModifiers(node) : node.modifiers) || [];
      if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        exports.set('default', node.name?.text || 'default');
        if (!node.name) decls.set('default', { kind: 'function', pos: node.getStart(sf) });
      }
      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        exports.set('default', ts.isIdentifier(node.expression) ? node.expression.text : 'default');
        if (!ts.isIdentifier(node.expression)) decls.set('default', { kind: 'function', pos: node.getStart(sf) });
      }
      if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) exports.set(el.name.text, (el.propertyName || el.name).text);
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
          && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require'
          && !require('./lexical').bindingAt(ts, node.initializer.expression, 'require')
          && ts.isStringLiteral(node.initializer.arguments[0])) {
        const mod = node.initializer.arguments[0].text;
        const recordRequire = (binding, imported) => {
          const entry = { module: mod, imported, binding, mode: ts.ModuleKind.CommonJS };
          bindingImports.set(binding, entry);
          // Only module-scope bindings participate in exports and type-name lookup.
          // A nested require must not replace the module's ESM or CommonJS import.
          if (ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) {
            imports.set(binding.name.text, entry);
          }
        };
        if (ts.isIdentifier(node.name)) recordRequire(node, '*');
        else if (ts.isObjectBindingPattern(node.name)) for (const el of node.name.elements) {
          if (ts.isIdentifier(el.name)) recordRequire(el, (el.propertyName || el.name).text);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
        const obj = node.left.expression.getText(sf);
        if (obj === 'exports' || obj === 'module.exports') {
          const name = node.left.name.text;
          exports.set(name, ts.isIdentifier(node.right) ? node.right.text : name);
          if (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right)) decls.set(name, { kind: 'function', pos: node.left.name.getStart(sf) });
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
      const nameNode = (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) ? node.name
        : ts.isConstructorDeclaration(node) ? node.getChildren(sf).find((k) => k.kind === ts.SyntaxKind.ConstructorKeyword) : null;
      if (nameNode) {
        enclosing.push({ label: currentClass ? `${currentClass}.${nameNode.getText(sf)}` : nameNode.getText(sf), pos: nameNode.getStart(sf) });
        pushed = true;
      } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        // Only adopt the variable's name when the arrow IS the initializer. For
        // `const result = await tx(async () => ...)` the variable holds the RESULT,
        // not the function, so attributing calls to `result` invents a caller.
        const vd = ts.findAncestor(node, (a) => ts.isVariableDeclaration(a) || ts.isPropertyDeclaration(a) || ts.isPropertyAssignment(a));
        if (vd && vd.initializer === node && vd.name && ts.isIdentifier(vd.name)) {
          // NOT qualified with the class: the TS call hierarchy labels a nested arrow
          // by its bare variable name, and qualifying it cost 5 points of recall.
          enclosing.push({ label: ts.isPropertyDeclaration(vd) && currentClass ? `${currentClass}.${vd.name.text}` : vd.name.text, pos: vd.name.getStart(sf) });
          pushed = true;
        }
      }

      if (ts.isNewExpression(node) && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) {
        const receiver = node.expression;
        const bindingName = ts.isIdentifier(receiver) ? receiver.text
          : ts.isIdentifier(receiver.expression) ? receiver.expression.text : null;
        calls.push({
          name: 'constructor', receiver: { kind: 'new', typeName: receiver.getText(sf),
            binding: bindingName && require('./lexical').bindingAt(ts, receiver, bindingName) },
          pos: node.expression.getStart(sf), ownerClass: currentClass, owner: ownerLabel(),
        });
      }
      if (ts.isCallExpression(node)) {
        const e = node.expression;
        const owner = ownerLabel();
        if (ts.isIdentifier(e)) {
          calls.push({ name: e.text, receiver: null, binding: require('./lexical').bindingAt(ts, e, e.text), pos: e.getStart(sf), ownerClass: currentClass, owner });
        } else if (ts.isPropertyAccessExpression(e)) {
          let recv = e.expression;
          while (ts.isNonNullExpression(recv) || ts.isParenthesizedExpression(recv)) recv = recv.expression;
          let receiver = null;
          if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword) {
            receiver = { kind: 'thisMember', name: recv.name.text };
          } else if (ts.isPropertyAccessExpression(recv) && ts.isIdentifier(recv.expression)) {
            receiver = { kind: 'ident', name: recv.getText(sf), binding: require('./lexical').bindingAt(ts, recv, recv.expression.text) };
          } else if (ts.isIdentifier(recv)) {
            const binding = require('./lexical').bindingAt(ts, recv, recv.text);
            const typeName = binding && (typeNameOf(binding.type) || (binding.initializer && ts.isNewExpression(binding.initializer) ? binding.initializer.expression.getText(sf) : null));
            receiver = { kind: 'ident', name: recv.text, typeName, binding };
          } else if (ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) && recv.expression.text === 'require'
              && recv.arguments.length === 1 && ts.isStringLiteralLike(recv.arguments[0])
              && !require('./lexical').bindingAt(ts, recv.expression, 'require')) {
            // `require('./m').fn()`: a namespace import with no binding.
            receiver = { kind: 'require', module: recv.arguments[0].text };
          } else if (recv.kind === ts.SyntaxKind.SuperKeyword) {
            receiver = { kind: 'super', static: staticContext(node) };
          } else if (recv.kind === ts.SyntaxKind.ThisKeyword) {
            receiver = { kind: 'this', static: staticContext(node) };
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

    const symbols = S.collect(sf);
    for (const sym of symbols) {
      if (!sym.nested && !sym.className) decls.set(sym.simpleName, { kind: 'function', pos: sym.namePos });
    }
    byFile.set(file, { file, imports, bindingImports, decls, classes, calls, localTypes, implementsEdges, extendsEdges, handlerFor, reExports, exports, symbols });
  }

  // --- module resolution, syntactic only -------------------------------------
  const has = (p) => byFile.has(p);
  const tryExt = (base) => {
    if (/\.(js|jsx|mjs|cjs)$/.test(base)) {
      const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
      for (const e of SOURCE_EXT) if (has(stem + e)) return stem + e;
    }
    if (has(base)) return base;
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
  const packageNames = new Map();
  for (const entry of packages) {
    // A manifest without a name still sets its directory's module format, but no import can name it.
    if (typeof entry.data?.name !== 'string') continue;
    // An ambiguous name is not enough evidence to connect two files.
    if (packageNames.has(entry.data.name)) packageNames.set(entry.data.name, null);
    else packageNames.set(entry.data.name, entry);
  }
  const packageAt = file => {
    const match = file.replace(/\\/g, '/').match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/);
    const entry = match && packageNames.get(match[1]);
    return entry ? { entry, rest: match[2] || '' } : null;
  };
  const actual = file => { const p = packageAt(file); return p ? path.join(p.entry.dir, p.rest) : file; };
  const directories = new Set();
  for (const file of texts.keys()) {
    let dir = path.dirname(file);
    while (!directories.has(dir)) { directories.add(dir); const parent = path.dirname(dir); if (parent === dir) break; dir = parent; }
  }
  const virtualHost = {
    fileExists: file => { const p = packageAt(file); return p?.rest === 'package.json' || has(actual(file)); },
    readFile: file => { const p = packageAt(file); return p?.rest === 'package.json' ? JSON.stringify(p.entry.data) : texts.get(actual(file)); },
    directoryExists: dir => /(?:^|[/\\])node_modules(?:[/\\]@[^/\\]+)?$/.test(dir) || directories.has(actual(dir)),
    realpath: actual,
  };
  const resolveCache = new Map();
  // The mode an `import` declaration in `fromFile` would get, for callers with no usage site.
  const importModeCache = new Map();
  const importModeOf = (fromFile) => {
    if (!importModeCache.has(fromFile)) {
      const probe = parse(fromFile, "import '_';");
      importModeCache.set(fromFile, modeAt(probe, probe.statements[0].moduleSpecifier));
    }
    return importModeCache.get(fromFile);
  };
  // `usage.mode` is the mode TypeScript gave the import site; `undefined` there is a real
  // answer (node10 has no mode). Without `usage`, the import is treated as an `import` declaration.
  const resolveModule = (fromFile, spec, usage = { mode: importModeOf(fromFile) }) => {
    const { mode } = usage;
    const ck = `${fromFile} ${spec} ${mode}`;
    if (resolveCache.has(ck)) return resolveCache.get(ck);
    let hit = null;
    const options = optionsFor(fromFile);
    const resolved = ts.resolveModuleName(spec, fromFile, options, virtualHost, undefined, undefined, mode).resolvedModule;
    if (resolved && has(actual(resolved.resolvedFileName))) hit = actual(resolved.resolvedFileName);
    if (hit) { resolveCache.set(ck, hit); return hit; }
    if (spec.startsWith('.')) {
      hit = tryExt(path.resolve(path.dirname(fromFile), spec));
    } else {
      for (const c of aliasCandidates(spec)) { hit = tryExt(c); if (hit) break; }
      if (!hit) for (const bd of baseDirs) { hit = tryExt(path.join(bd, spec)); if (hit) break; }
    }
    resolveCache.set(ck, hit);
    return hit;
  };

  // Export resolution stays inside the fetched source set.
  const exportTarget = (file, name, seen = new Set()) => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const rec = byFile.get(file);
    if (!rec) return null;
    const local = rec.exports.get(name) || name;
    if (rec.decls.has(local)) return { file, name: local, pos: rec.decls.get(local).pos };
    const imp = rec.imports.get(local);
    if (imp) return exportTarget(resolveModule(file, imp.module, { mode: imp.mode }), imp.imported, seen);
    for (const re of rec.reExports) {
      if (re.names && !Object.hasOwn(re.names, name)) continue;
      const hit = exportTarget(resolveModule(file, re.module, { mode: re.mode }), re.names ? re.names[name] : name, seen);
      if (hit) return hit;
    }
    return null;
  };
  const declarationFor = (rec, name, lexicalBinding = null) => {
    const importFor = local => lexicalBinding ? rec.bindingImports.get(lexicalBinding) : rec.imports.get(local);
    if (name && name.includes('.')) {
      const [namespace, member] = name.split('.');
      const binding = importFor(namespace);
      if (binding?.imported === '*') return exportTarget(resolveModule(rec.file, binding.module, { mode: binding.mode }), member);
    }
    const imp = importFor(name);
    if (imp) return exportTarget(resolveModule(rec.file, imp.module, { mode: imp.mode }), imp.imported);
    if (rec.decls.has(name)) return { file: rec.file, name, pos: rec.decls.get(name).pos };
    return null;
  };
  const declaringFileFor = (rec, name) => declarationFor(rec, name)?.file;


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
    for (const e of rec.implementsEdges) link(declarationFor(rec, e.iface)?.name || e.iface, e.cls);
    for (const e of rec.extendsEdges) link(declarationFor(rec, e.parent)?.name || e.parent, e.child);
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

  const staticOwner = (decl, method, seen = new Set()) => {
    if (!decl || seen.has(`${decl.file}#${decl.name}`)) return null;
    seen.add(`${decl.file}#${decl.name}`);
    const rec = byFile.get(decl.file), cls = rec?.classes.get(decl.name);
    if (!cls) return null;
    if (cls.methods.has(method)) return cls.staticMethods.has(method) ? decl : null;
    for (const edge of rec.extendsEdges.filter(e => e.child === decl.name)) {
      const hit = staticOwner(declarationFor(rec, edge.parent), method, seen);
      if (hit) return hit;
    }
    return null;
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
    const handler = target.className && handlerCommand.get(target.className);
    const commands = handler && target.name === handler.method ? handler.commands : [];

    for (const rec of byFile.values()) {
      for (const c of rec.calls) {
        if (commands.length && c.receiver && c.receiver.kind === 'new' && commands.includes(c.receiver.typeName)) {
          if (c.owner) {
            const id2 = `${rec.file}#${c.owner.pos}`;
            if (!out.has(id2)) out.set(id2, { file: rec.file, label: c.owner.label, pos: c.owner.pos, via: 'cqrs', callSites: [] });
            out.get(id2).callSites.push({ start: c.pos, end: c.pos + String(c.name).length });
          }
          continue;
        }
        const bareImport = !c.receiver && c.binding && rec.bindingImports.get(c.binding);
        const bareTarget = !c.receiver && (bareImport
          ? exportTarget(resolveModule(rec.file, bareImport.module, { mode: bareImport.mode }), bareImport.imported)
          : c.binding ? { file: rec.file, name: c.name, pos: c.binding.name?.getStart() }
            : declarationFor(rec, c.name));
        const receiverImport = c.receiver?.kind === 'ident'
          && (c.receiver.binding ? rec.bindingImports.get(c.receiver.binding) : rec.imports.get(c.receiver.name));
        const ns = receiverImport && !c.receiver.name.includes('.') ? receiverImport : null;
        const namespaceTarget = ns?.imported === '*' ? exportTarget(resolveModule(rec.file, ns.module, { mode: ns.mode }), c.name)
          : c.receiver?.kind === 'require' ? exportTarget(resolveModule(rec.file, c.receiver.module, { mode: ts.ModuleKind.CommonJS }), c.name)
            : null;
        if (c.name !== target.name && bareTarget?.name !== target.name && namespaceTarget?.name !== target.name) continue;
        let ok = false;
        if (c.receiver && c.receiver.kind === 'new') {
          const d = declarationFor(rec, c.receiver.typeName, c.receiver.binding);
          ok = target.name === 'constructor' && d?.file === target.file && d.name === target.className;
        } else if (!c.receiver) {
          ok = !target.className && bareTarget?.file === target.file && bareTarget.name === target.name && (target.pos == null || bareTarget.pos === target.pos);
        } else if (namespaceTarget && !target.className) {
          ok = namespaceTarget.file === target.file && namespaceTarget.name === target.name;
        } else if (c.receiver.kind === 'ident' && !c.receiver.typeName
          && (!c.receiver.binding || receiverImport || ts.isClassDeclaration(c.receiver.binding))) {
          // A class declared in an enclosing scope shadows an import of the same name.
          const local = !ns && c.receiver.binding && ts.isClassDeclaration(c.receiver.binding) && !c.receiver.name.includes('.');
          const cls = staticOwner(local ? { file: rec.file, name: c.receiver.binding.name.text }
            : declarationFor(rec, c.receiver.name, c.receiver.binding), target.name);
          ok = !!cls && cls.file === target.file && cls.name === target.className;
        } else if ((c.receiver.kind === 'this' || c.receiver.kind === 'super') && c.receiver.static) {
          const owners = c.receiver.kind === 'this' ? [declarationFor(rec, c.ownerClass)]
            : rec.extendsEdges.filter(e => e.child === c.ownerClass).map(e => declarationFor(rec, e.parent));
          ok = owners.some(owner => { const cls = staticOwner(owner, target.name); return cls?.file === target.file && cls.name === target.className; });
        } else if (c.receiver.kind === 'super') {
          ok = !!target.className && supertypesOf(c.ownerClass || '').has(target.className);
        } else if (c.receiver.kind === 'this') {
          if (c.ownerClass === target.className) ok = rec.file === target.file;
          // `this.foo()` in a subclass reaches a method declared on the base class
          else ok = !!target.className && supertypesOf(c.ownerClass || '').has(target.className);
        } else {
          const rawType = c.receiver.kind === 'thisMember'
            ? (rec.classes.get(c.ownerClass) || { members: new Map() }).members.get(c.receiver.name)
            : c.receiver.typeName;
          const resolvedType = rawType && declarationFor(rec, rawType);
          const typeName = resolvedType?.name || rawType;
          const overrides = typeName && typeName !== target.className && subs.has(typeName)
            && [...byFile.values()].some((r) => r.classes.get(typeName)?.methods.has(target.name));
          if (typeName && typeMatches(typeName) && !overrides) {
            const declFile = resolvedType?.file || declaringFileFor(rec, typeName);
            // A port and its adapter live in different files by design, so a file
            // mismatch only disqualifies a match on the target's OWN class name.
            ok = typeName !== target.className || !declFile || declFile === target.file;
          }
        }
        if (ok && target.className && byFile.get(target.file)?.classes.get(target.className)?.staticMethods.has(target.name)
          && (c.receiver?.typeName || c.receiver?.kind === 'thisMember' || ((c.receiver?.kind === 'this' || c.receiver?.kind === 'super') && !c.receiver.static))) ok = false;
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
    for (const sym of rec.symbols) symbolIndex.set(`${rec.file}#${sym.namePos}`, { className: sym.nested ? null : sym.className, name: sym.simpleName });
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
