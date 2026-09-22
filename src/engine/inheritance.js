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

const EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];

function createInheritanceFilter(ts, { readFile, trace = () => {} } = {}) {
  if (!ts) return null;
  const read = readFile || ((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } });

  const parsed = new Map();
  // file -> { classes: Map<name, {heritage:[names], methods:Set}>, imports: Map<name, module> }
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
    const reExports = [];
    const visit = (n) => {
      if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
        reExports.push({
          module: n.moduleSpecifier.text,
          names: n.exportClause && ts.isNamedExports(n.exportClause)
            ? n.exportClause.elements.map((el) => el.name.text) : null,   // null = export *
        });
        return;
      }
      if (ts.isImportDeclaration(n) && n.moduleSpecifier && n.importClause) {
        const mod = n.moduleSpecifier.text;
        const c = n.importClause;
        if (c.name) imports.set(c.name.text, mod);
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) imports.set(el.name.text, mod);
        }
        return;
      }
      if ((ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name) {
        const heritage = [];
        for (const h of n.heritageClauses || []) {
          for (const t of h.types) if (ts.isIdentifier(t.expression)) heritage.push(t.expression.text);
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

    const rec = { file, sf, classes, imports, reExports };
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
          const co = (cfg && cfg.compilerOptions) || {};
          out = { baseUrl: path.resolve(dir, co.baseUrl || '.'), paths: co.paths || null };
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
  // barrel hops -- an index.ts almost never declares what it re-exports.
  const declCache = new Map();
  function fileDeclaring(file, name) {
    const ck = `${file}#${name}`;
    if (declCache.has(ck)) return declCache.get(ck);
    declCache.set(ck, null);                       // guard against re-export cycles
    const rec = parse(file);
    if (!rec) return null;
    if (rec.classes.has(name)) { declCache.set(ck, file); return file; }
    const mod = rec.imports.get(name);
    if (!mod) return null;
    const f = resolveFrom(file, mod);
    if (!f) return null;
    const found = declaringVia(f, name, 0);
    declCache.set(ck, found);
    return found;
  }

  function declaringVia(file, name, depth) {
    if (depth > 4) return null;
    const rec = parse(file);
    if (!rec) return null;
    if (rec.classes.has(name)) return file;
    for (const re of rec.reExports) {
      if (re.names && !re.names.includes(name)) continue;
      const f2 = resolveFrom(file, re.module);
      if (!f2) continue;
      const hit = declaringVia(f2, name, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  const ancestorCache = new Map();
  // Transitive extends/implements names reachable from (file, className).
  function ancestorsOf(file, className, depth = 0) {
    const key = `${file}#${className}`;
    if (ancestorCache.has(key)) return ancestorCache.get(key);
    const out = new Set();
    if (depth > 8) return out;                    // cycle / pathological guard
    ancestorCache.set(key, out);                  // set early: heritage can be cyclic
    const rec = parse(file);
    const entry = rec && rec.classes.get(className);
    if (!entry) return out;
    for (const parent of entry.heritage) {
      if (out.has(parent)) continue;
      out.add(parent);
      const pf = fileDeclaring(file, parent);
      if (!pf) continue;
      for (const g of ancestorsOf(pf, parent, depth + 1)) out.add(g);
    }
    return out;
  }

  function ancestorDeclares(file, className, method) {
    for (const a of ancestorsOf(file, className)) {
      const af = fileDeclaring(file, a);
      if (!af) continue;
      const rec = parse(af);
      const entry = rec && rec.classes.get(a);
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
      let found = null;
      const scan = (n) => {
        if (found) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === wanted && n.type) {
          found = typeName(n.type);
        } else if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === wanted && n.type) {
          found = typeName(n.type);
        } else if (ts.isPropertyDeclaration(n) && n.name && n.name.getText(sf) === wanted && n.type) {
          found = typeName(n.type);
        }
        ts.forEachChild(n, scan);
      };
      ts.forEachChild(sf, scan);
      return found;
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
      const nm = ts.isQualifiedName(n2) ? n2.right.text : n2.text;
      if (/^(Promise|Array|Readonly|Partial)$/.test(nm) && t.typeArguments && t.typeArguments.length === 1) {
        const inner = t.typeArguments[0];
        return inner && ts.isTypeReferenceNode(inner)
          ? (ts.isQualifiedName(inner.typeName) ? inner.typeName.right.text : inner.typeName.text) : null;
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
      const visit = (n, cls) => {
        if (out) return;
        let cur = cls;
        if ((ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name) cur = n.name.text;
        if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n)) && n.name
          && n.name.getStart(sf) === pos) {
          out = { file, className: cur || null, name: n.name.getText(sf) };
          return;
        }
        ts.forEachChild(n, (k) => visit(k, cur));
      };
      ts.forEachChild(sf, (k) => visit(k, undefined));
    }
    targetCache.set(ck, out);
    return out;
  }

  // caller: { file, callSites: [{start}] } as produced by either resolver
  function isSiblingDispatch(target, caller) {
    if (!target || !target.className || !target.name) return false;
    if (!caller || !caller.callSites || !caller.callSites.length) return false;
    if (!ancestorDeclares(target.file, target.className, target.name)) return false;

    const targetAncestors = ancestorsOf(target.file, target.className);
    let unrelated = 0;
    for (const site of caller.callSites) {
      const t = receiverTypeAt(caller.file, site.start);
      if (!t) return false;                                  // unreadable -> keep
      if (t === target.className) return false;
      if (targetAncestors.has(t)) return false;              // typed as the port
      const tf = fileDeclaring(caller.file, t);
      if (!tf) return false;                                 // cannot judge -> keep
      if (ancestorsOf(tf, t).has(target.className)) return false;   // a subclass
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

  return { filterCallers, filterAt, targetAt, isSiblingDispatch, ancestorsOf, ancestorDeclares, receiverTypeAt };
}

module.exports = { createInheritanceFilter };
