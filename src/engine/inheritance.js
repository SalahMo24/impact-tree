'use strict';
// Precision filter for the TypeScript call hierarchy.
//
// Asked for callers of a method that OVERRIDES a base-class method, TypeScript also
// returns call sites that dispatch on sibling subclasses which do not declare the
// method at all. `this.<OtherRepo>.save()` comes back as an incoming call to
// `ThisRepo.save`, when at runtime it reaches `BaseRepository.save`. On one real
// symbol that was 25 of 31 reported callers. See docs/tier-a.md.
//
// The rule is deliberately conservative -- an edge is dropped only when all of these
// hold, and anything undeterminable keeps the edge:
//
//   1. some ancestor of the target's class also declares the method (so there IS
//      something to confuse it with), and
//   2. every reported call site in that caller dispatches on a type we can read, and
//   3. none of those types is the target's class, an ancestor of it, or a descendant.
//
// Hiding a real caller is worse than showing a spurious one, so every uncertain case
// resolves in favour of keeping the edge.
const fs = require('fs');
const path = require('path');
const { canonical } = require('./canonical-path');

const EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];

function createInheritanceFilter(ts, { readFile, trace = () => {} } = {}) {
  if (!ts) return null;
  const read = readFile || ((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } });

  // Caches: `parsed` (class and import summary per file), `cfgCache` (tsconfig per
  // directory), `declCache`, `ancestorCache` and `targetCache` (answers derived from
  // them). Owner: this filter, created by the resolver that uses it: per project for the
  // TypeScript resolver, and for the session's whole life for the editor resolver.
  // Key: file path (or directory), plus the class, method or position asked about; the
  // text comes from `readFile` at the time of the first read and the TypeScript module
  // is fixed, so a file's content is not part of any key. Invalidation: `clear()`,
  // which the editor resolver calls at the start of every local analysis; the TypeScript
  // resolver is rebuilt per run. Disposal: with the filter.
  const parsed = new Map();
  const scopeTypeNames = new WeakMap();
  // file -> { classes: Map<name, {heritage:[names], methods:Set}>, imports: Map<name, {module, imported}> }
  function parse(file) {
    if (parsed.has(file)) return parsed.get(file);
    const text = read(file);
    if (text == null) { parsed.set(file, null); return null; }
    let sf;
    try {
      sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined);
    } catch { parsed.set(file, null); return null; }

    const classes = new Map();
    const imports = new Map();
    const localExports = new Map();
    const typeAliases = new Set();
    const reExports = [];
    const visit = (n) => {
      if (ts.isExportDeclaration(n) && !n.moduleSpecifier && n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const el of n.exportClause.elements) localExports.set(el.name.text, (el.propertyName || el.name).text);
        return;
      }
      if (ts.isExportAssignment(n) && !n.isExportEquals) {
        localExports.set('default', ts.isIdentifier(n.expression) ? n.expression.text : null);
        return;
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
        const clause = n.exportClause;
        // `namespace`: the one name `export * as ns` exposes. `names`: exported name ->
        // name in the source module (`export { A as B }` maps B to A). Neither: `export *`.
        reExports.push({
          module: n.moduleSpecifier.text,
          namespace: clause && ts.isNamespaceExport(clause) ? clause.name.text : null,
          names: clause && ts.isNamedExports(clause)
            ? new Map(clause.elements.map((el) => [el.name.text, (el.propertyName || el.name).text])) : null,
        });
        return;
      }
      if (ts.isImportDeclaration(n) && n.moduleSpecifier && n.importClause) {
        const mod = n.moduleSpecifier.text;
        const c = n.importClause;
        if (c.name) imports.set(c.name.text, { module: mod, imported: 'default' });
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
          imports.set(c.namedBindings.name.text, { module: mod, imported: '*' });
        }
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) imports.set(el.name.text,
            { module: mod, imported: (el.propertyName || el.name).text });
        }
        return;
      }
      if (n.parent === sf) {
        if (ts.isTypeAliasDeclaration(n)) typeAliases.add(n.name.text);
        const modifiers = (ts.getModifiers ? ts.getModifiers(n) : n.modifiers) || [];
        if (modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
          localExports.set('default', n.name?.text || null);
        } else if (modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          const bindings = ts.isVariableStatement(n) ? n.declarationList.declarations.map(d => d.name) : n.name ? [n.name] : [];
          while (bindings.length) {
            const binding = bindings.pop();
            if (ts.isIdentifier(binding)) localExports.set(binding.text, binding.text);
            else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
              for (const el of binding.elements) if (!ts.isOmittedExpression(el)) bindings.push(el.name);
            }
          }
        }
      }
      // Nested declarations have lexical scopes that this file-level summary cannot
      // prove. Leave them unknown rather than merging them with an exported namesake.
      if (n.parent === sf && (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name) {
        const heritage = [];
        for (const h of n.heritageClauses || []) {
          for (const t of h.types) heritage.push(t.expression.getText(sf));
        }
        const methods = new Set();
        for (const m of n.members || []) {
          if ((ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isGetAccessorDeclaration(m))
            && m.name) methods.add(m.name.getText(sf));
          if (ts.isConstructorDeclaration(m)) methods.add('constructor');
        }
        const prev = classes.get(n.name.text);
        if (prev) {
          prev.heritage.push(...heritage);
          methods.forEach((x) => prev.methods.add(x));
        } else {
          classes.set(n.name.text, { heritage, methods });
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);

    const rec = { file, sf, classes, imports, localExports, typeAliases, reExports };
    parsed.set(file, rec);
    return rec;
  }

  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const withExt = (base) => {
    for (const e of EXT) if (exists(base + e)) return base + e;
    for (const e of EXT) if (exists(path.join(base, 'index' + e))) return path.join(base, 'index' + e);
    return null;
  };

  // Non-relative specifiers are the common case in these codebases: `baseUrl: "."`
  // turns `src/foo/bar` into a path, not a package. Without this the heritage chain
  // stops at the first `extends` and the filter silently never fires.
  const cfgCache = new Map();
  function tsconfigFor(file) {
    let dir = path.dirname(file);
    const chain = [];
    for (let i = 0; i < 12; i++) {
      if (cfgCache.has(dir)) { const hit = cfgCache.get(dir); chain.forEach((d) => cfgCache.set(d, hit)); return hit; }
      chain.push(dir);
      const cfgPath = path.join(dir, 'tsconfig.json');
      if (exists(cfgPath)) {
        let out = null;
        try {
          const cfg = ts.parseConfigFileTextToJson(cfgPath, fs.readFileSync(cfgPath, 'utf8')).config;
          const co = ts.parseJsonConfigFileContent(cfg || {}, ts.sys, dir, undefined, cfgPath).options;
          out = { baseUrl: co.baseUrl || co.pathsBasePath || dir, paths: co.paths || null };
        } catch { out = null; }
        chain.forEach((d) => cfgCache.set(d, out));
        return out;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    chain.forEach((d) => cfgCache.set(d, null));
    return null;
  }

  const resolveFrom = (fromFile, spec) => {
    if (spec.startsWith('.')) return withExt(path.resolve(path.dirname(fromFile), spec));
    const cfg = tsconfigFor(fromFile);
    if (!cfg) return null;
    if (cfg.paths) {
      for (const [pattern, targets] of Object.entries(cfg.paths)) {
        const star = pattern.indexOf('*');
        let cands = [];
        if (star === -1) { if (pattern === spec) cands = targets.map((t) => path.resolve(cfg.baseUrl, t)); }
        else {
          const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
          if (!spec.startsWith(pre) || !spec.endsWith(post)) continue;
          const mid = spec.slice(pre.length, spec.length - post.length);
          cands = targets.map((t) => path.resolve(cfg.baseUrl, t.replace('*', mid)));
        }
        for (const c of cands) { const hit = withExt(c); if (hit) return hit; }
      }
    }
    return withExt(path.join(cfg.baseUrl, spec));
  };

  // Where is `name` declared, starting from `file`? Follows the import and then any
  // barrel hops -- an index.ts almost never declares what it re-exports. The answer is
  // { file, name }: `name` there is the declared name, which differs from the asked one
  // when a barrel renames (`export { Base as Renamed }`).
  const declCache = new Map();
  function fileDeclaring(file, name) {
    const ck = `${file}#${name}`;
    if (declCache.has(ck)) return declCache.get(ck);
    declCache.set(ck, null);                       // guard against re-export cycles
    const rec = parse(file);
    if (!rec) return null;
    if (rec.classes.has(name)) { const d = { file, name }; declCache.set(ck, d); return d; }
    const [local, ...members] = name.split('.').map(part => part.trim());
    const imp = rec.imports.get(local);
    if (!imp || (imp.imported === '*' && !members.length)) return null;
    const found = declaringImport(file, imp, members, 0);
    declCache.set(ck, found);
    return found;
  }

  function declaringImport(file, imp, members, depth) {
    if (imp.imported === '*' && !members.length) return null;
    const f = resolveFrom(file, imp.module);
    if (!f) return null;
    // An exported string name may itself contain dots. Keep namespace members
    // separate from that binding name rather than treating it as a qualified name.
    const imported = imp.imported === '*' ? members[0] : imp.imported;
    return declaringVia(f, imported, depth, imp.imported === '*' ? members.slice(1) : members);
  }

  // A null result means "not found", and every caller treats it as "inheritance unknown":
  // ancestorsOf stops climbing, ancestorDeclares skips the ancestor, and isSiblingDispatch
  // and heritageKnown keep the edge. So the depth limit below can only keep an edge, never
  // drop one.
  function declaringVia(file, name, depth, members = []) {
    if (depth > 4) return null;
    const rec = parse(file);
    if (!rec) return null;
    // Only exported local bindings take precedence. A private same-named class
    // must not hide the declaration exported from another module.
    if (rec.localExports.has(name)) {
      const local = rec.localExports.get(name);
      if (!local) return null;
      if (!members.length && rec.classes.has(local)) return { file, name: local };
      const imp = rec.imports.get(local);
      return imp ? declaringImport(file, imp, members, depth + 1) : null;
    }
    // Explicit exports override `export *` whatever the statement order, and are conclusive:
    // an `export * as name` exposes a namespace, not a class, and an unresolvable named
    // re-export must not fall through to an unrelated star.
    const explicit = rec.reExports.find((re) => re.namespace === name || (re.names && re.names.has(name)));
    if (explicit) {
      if (explicit.namespace && !members.length) return null;
      const f2 = resolveFrom(file, explicit.module);
      const imported = explicit.namespace ? members[0] : explicit.names.get(name);
      return f2 ? declaringVia(f2, imported, depth + 1, explicit.namespace ? members.slice(1) : members) : null;
    }
    // Stars do not export a module's default binding.
    if (name === 'default') return null;
    for (const re of rec.reExports) {
      if (re.namespace || re.names) continue;
      const f2 = resolveFrom(file, re.module);
      if (!f2) continue;
      const hit = declaringVia(f2, name, depth + 1, members);
      if (hit) return hit;
    }
    return null;
  }

  const ancestorCache = new Map();
  // Dependencies resolve from the path used to reach a declaration. Two symlinks to
  // one file can import different neighbours, so traversal/cache keys preserve that
  // context even though class comparisons use the canonical physical path below.
  const contextPaths = new Map();
  const contextPath = (file) => {
    if (!contextPaths.has(file)) {
      const resolved = path.resolve(file);
      contextPaths.set(file, path.sep === '\\' ? resolved.toLowerCase() : resolved);
    }
    return contextPaths.get(file);
  };
  const contextKey = (file, name) => JSON.stringify([contextPath(file), name]);
  // Resolve each path spelling once per analysis, including symlinks and Windows case.
  const canonicalPaths = new Map();
  const classKey = (file, name) => {
    if (!canonicalPaths.has(file)) canonicalPaths.set(file, canonical(file));
    return JSON.stringify([canonicalPaths.get(file), name]);
  };
  const sameDeclaration = (left, right) => classKey(left.file, left.name) === classKey(right.file, right.name);
  const hasAncestor = (ancestry, declaration) => ancestry.identities.has(classKey(declaration.file, declaration.name));
  // Keep declaration identities as well as the heritage names used for inspection.
  // A barrel alias and the declared name refer to the same class; a matching name
  // in another file does not. Visit by identity so cycles terminate without truncating
  // a known relationship or resolving a transitive parent's name in the wrong file.
  function ancestryOf(file, className) {
    const key = contextKey(file, className);
    if (ancestorCache.has(key)) return ancestorCache.get(key);
    const out = { names: new Set(), declarations: new Map(), identities: new Set() };
    const seen = new Set();
    const pending = [{ file, name: className }];
    while (pending.length) {
      const current = pending.pop();
      const ck = contextKey(current.file, current.name);
      if (seen.has(ck)) continue;
      seen.add(ck);
      const entry = parse(current.file)?.classes.get(current.name);
      if (!entry) continue;
      for (const parent of entry.heritage) {
        out.names.add(parent);
        const pd = fileDeclaring(current.file, parent);
        if (!pd) continue;
        out.declarations.set(contextKey(pd.file, pd.name), pd);
        out.identities.add(classKey(pd.file, pd.name));
        pending.push(pd);
      }
    }
    ancestorCache.set(key, out);
    return out;
  }

  function ancestorsOf(file, className) { return ancestryOf(file, className).names; }

  function heritageKnown(file, name, seen = new Set()) {
    const key = `${file}#${name}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const entry = parse(file)?.classes.get(name);
    if (!entry) return false;
    return entry.heritage.every((parent) => {
      const d = fileDeclaring(file, parent);
      return d && heritageKnown(d.file, d.name, seen);
    });
  }

  function ancestorDeclares(file, className, method) {
    for (const ad of ancestryOf(file, className).declarations.values()) {
      const rec = parse(ad.file);
      const entry = rec && rec.classes.get(ad.name);
      if (entry && entry.methods.has(method)) return true;
    }
    return false;
  }

  // The declared type of the receiver at a call site, read syntactically.
  function receiverTypeAt(callerFile, offset) {
    const rec = parse(callerFile);
    if (!rec) return null;
    const sf = rec.sf;
    let node = null;
    const find = (n) => {
      if (offset < n.getStart(sf) || offset > n.getEnd()) return;
      node = n;
      ts.forEachChild(n, find);
    };
    ts.forEachChild(sf, find);
    if (!node) return null;

    let pa = node;
    while (pa && !ts.isPropertyAccessExpression(pa)) pa = pa.parent;
    if (!pa) return null;
    const recv = pa.expression;

    // `this.member.foo()` -- look the member up on the enclosing class
    if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const memberName = recv.name.text;
      let cls = pa;
      while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
      if (!cls) return null;
      for (const m of cls.members || []) {
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            if (ts.isIdentifier(p.name) && p.name.text === memberName) return typeName(p.type);
          }
        } else if (ts.isPropertyDeclaration(m) && m.name && m.name.getText(sf) === memberName) {
          return typeName(m.type);
        }
      }
      return null;
    }
    // `obj.foo()` where obj is a typed local or parameter
    if (ts.isIdentifier(recv)) {
      const wanted = recv.text;
      // Resolve the nearest lexical binding, including an untyped shadow. Never
      // infer a parameter from an unrelated method elsewhere in the file.
      const binding = require('./lexical').bindingAt(ts, recv, wanted);
      return binding ? typeName(binding.type) : null;
    }
    return null;

    function typeName(tn) {
      if (!tn) return null;
      let t = tn;
      while (t && ts.isArrayTypeNode(t)) t = t.elementType;
      if (t && ts.isUnionTypeNode(t)) {
        const named = t.types.filter((x) => ts.isTypeReferenceNode(x));
        if (named.length !== 1) return null;
        t = named[0];
      }
      if (!t || !ts.isTypeReferenceNode(t)) return null;
      const n2 = t.typeName;
      const qualified = n => ts.isQualifiedName(n) ? `${qualified(n.left)}.${n.right.text}` : n.text;
      const nm = qualified(n2);
      // Generic parameters and block-local type declarations can shadow imports.
      // This syntax filter does not resolve those types or their constraints, so
      // retaining the caller is safer than looking up a same-named file-level import.
      const local = nm.split('.')[0];
      if (rec.typeAliases.has(local)) return null;
      for (let scope = t.parent; scope; scope = scope.parent) {
        if (scope.typeParameters?.some(p => p.name.text === local)) return null;
        if (ts.isBlock(scope) || ts.isModuleBlock(scope)) {
          if (!scopeTypeNames.has(scope)) {
            scopeTypeNames.set(scope, new Set(scope.statements.filter(s => ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)
              || ts.isClassDeclaration(s) || ts.isModuleDeclaration(s)).map(s => s.name?.text)));
          }
          if (scopeTypeNames.get(scope).has(local)) return null;
        }
      }
      if (/^(Promise|Array|Readonly|Partial)$/.test(nm) && !rec.imports.has(nm) && !rec.classes.has(nm)
        && t.typeArguments && t.typeArguments.length === 1) {
        const inner = t.typeArguments[0];
        return inner && ts.isTypeReferenceNode(inner) ? typeName(inner) : null;
      }
      return nm;
    }
  }

  // The resolvers know only (file, pos). Recover the class and method name at that
  // declaration so the filter can be applied without changing their call signatures.
  const targetCache = new Map();
  function targetAt(file, pos) {
    const ck = `${file}#${pos}`;
    if (targetCache.has(ck)) return targetCache.get(ck);
    let out = null;
    const rec = parse(file);
    if (rec) {
      const sf = rec.sf;
      const visit = (n) => {
        if (out) return;
        if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n)) && n.name
          && n.name.getStart(sf) === pos) {
          const owner = n.parent;
          const className = (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner))
            && owner.parent === sf ? owner.name?.text || null : null;
          out = { file, className, name: n.name.getText(sf) };
          return;
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
    }
    targetCache.set(ck, out);
    return out;
  }

  // caller: { file, callSites: [{start}] } as produced by either resolver
  function isSiblingDispatch(target, caller) {
    if (!target || !target.className || !target.name) return false;
    if (!caller || !caller.callSites || !caller.callSites.length) return false;
    if (!ancestorDeclares(target.file, target.className, target.name)) return false;

    const targetDeclaration = { file: target.file, name: target.className };
    const targetAncestors = ancestryOf(target.file, target.className);
    let unrelated = 0;
    for (const site of caller.callSites) {
      const t = receiverTypeAt(caller.file, site.start);
      if (!t) return false;                                  // unreadable -> keep
      const td = fileDeclaring(caller.file, t);
      if (!td) return false;                                 // cannot judge -> keep
      if (sameDeclaration(td, targetDeclaration)) return false;
      if (hasAncestor(targetAncestors, td)) return false;     // typed as the port
      if (hasAncestor(ancestryOf(td.file, td.name), targetDeclaration)) return false;   // a subclass
      if (!heritageKnown(td.file, td.name) || !heritageKnown(target.file, target.className)) return false;
      unrelated++;
    }
    return unrelated > 0;
  }

  // Returns the kept callers, and how many were dropped, so the log can say so.
  function filterCallers(target, callers) {
    const kept = [];
    let dropped = 0;
    for (const c of callers) {
      if (isSiblingDispatch(target, c)) { dropped++; continue; }
      kept.push(c);
    }
    if (dropped) trace(`dropped ${dropped} inherited-member over-report(s) for ${target.className}.${target.name}`);
    return { kept, dropped };
  }

  // Convenience for the resolvers: filter by position, no-op when the position is
  // not a method declaration (a free function cannot have an inherited twin).
  function filterAt(file, pos, callers) {
    const target = targetAt(file, pos);
    if (!target || !target.className) return { kept: callers, dropped: 0 };
    return filterCallers(target, callers);
  }

  return { clear() { parsed.clear(); cfgCache.clear(); declCache.clear(); ancestorCache.clear(); contextPaths.clear(); canonicalPaths.clear(); targetCache.clear(); }, filterCallers, filterAt, targetAt, isSiblingDispatch, ancestorsOf, ancestorDeclares, receiverTypeAt };
}

module.exports = { createInheritanceFilter };
