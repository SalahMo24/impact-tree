'use strict';

function makeSymbols(ts) {
  const funcLike = (n) => {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) return n;
    if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.initializer;
    // `export default (a) => {}` and `export default function () {}` both have no name
    // of their own; the module's default export is how every importer refers to them.
    if (ts.isExportAssignment(n) && !n.isExportEquals && n.expression &&
        (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))) return n.expression;
    // CommonJS: `exports.x = function () {}` / `module.exports.x = () => {}`
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && cjsExportName(n.left) && (ts.isArrowFunction(n.right) || ts.isFunctionExpression(n.right))) return n.right;
    return null;
  };

  // `exports.x` or `module.exports.x` -> the `x` name node, else null
  function cjsExportName(left) {
    if (!ts.isPropertyAccessExpression(left)) return null;
    const obj = left.expression;
    const isExports = ts.isIdentifier(obj) && obj.text === 'exports';
    const isModuleExports = ts.isPropertyAccessExpression(obj) && ts.isIdentifier(obj.expression)
      && obj.expression.text === 'module' && obj.name.text === 'exports';
    return isExports || isModuleExports ? left.name : null;
  }

  // The token a symbol is anchored at. A constructor has no name node, and its first
  // token is a modifier when there is one (`private constructor`), so find the keyword.
  function nameNodeOf(node, sf) {
    if (ts.isConstructorDeclaration(node)) {
      return node.getChildren(sf).find((k) => k.kind === ts.SyntaxKind.ConstructorKeyword) || node.getFirstToken(sf);
    }
    if (ts.isExportAssignment(node)) {
      return node.getChildren(sf).find((k) => k.kind === ts.SyntaxKind.DefaultKeyword) || node.getFirstToken(sf);
    }
    if (ts.isBinaryExpression(node)) return cjsExportName(node.left);
    if (ts.isFunctionDeclaration(node) && !node.name) {
      return node.getChildren(sf).find((k) => k.kind === ts.SyntaxKind.DefaultKeyword)
        || node.getChildren(sf).find((k) => k.kind === ts.SyntaxKind.FunctionKeyword) || null;
    }
    return node.name || null;
  }

  // getModifiers/getDecorators arrived in TypeScript 4.8; before that they were plain
  // node properties. A project pinned to an older compiler crashed the whole run.
  const modifiersOf = (n) => (ts.getModifiers
    ? (ts.canHaveModifiers(n) ? ts.getModifiers(n) || [] : [])
    : (n.modifiers || []).filter((m) => m.kind !== ts.SyntaxKind.Decorator));
  const decoratorNodes = (n) => (ts.getDecorators
    ? (ts.canHaveDecorators(n) ? ts.getDecorators(n) || [] : [])
    : n.decorators || []);
  const decoratorsOf = (n) => decoratorNodes(n)
    .map((d) => `@${(ts.isCallExpression(d.expression) ? d.expression.expression : d.expression).getText()}`);

  function paramsOf(fn, sf) {
    return (fn.parameters || []).map((p) => ({
      name: p.name.getText(sf),
      type: p.type ? p.type.getText(sf).replace(/\s+/g, ' ') : null,
      optional: !!p.questionToken || !!p.initializer,
      rest: !!p.dotDotDotToken,
    }));
  }

  function throwsOf(fn, sf) {
    const out = new Set();
    const visit = (n) => {
      // A nested callable owns its throws; declaring it does not execute its body.
      if (ts.isFunctionLike(n)) return;
      if (ts.isThrowStatement(n) && n.expression) out.add(n.expression.getText(sf).replace(/\s+/g, ' ').slice(0, 120));
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    return out;
  }

  const renderSig = (s) =>
    `${s.async ? 'async ' : ''}(${s.params.map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional ? '?' : ''}: ${p.type || '⟨inferred⟩'}`).join(', ')}) => ${s.returns || '⟨inferred⟩'}`;

  // A value-passed function (`transaction(executeTransaction)`) has references but no
  // call-hierarchy edge. Recording the kind lets the resolver report `unknown`, not `0`.
  //
  // `label` is for display and can repeat within a file (a get/set pair, overloads, a
  // helper named `cb` in two methods). `key` is unique per file and stable across
  // base and head, so the base version a head symbol is compared against is the right one.
  function collect(sf, { includeConstructors = true } = {}) {
    const out = [];
    const overloadSeen = new Map();
    const visit = (node, cls, enclosing, clsPos) => {
      let c = cls;
      let cPos = clsPos;
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) { c = node.name.text; cPos = node.name.getStart(sf); }
      const fn = funcLike(node);
      let nextEnclosing = enclosing;
      if (fn) {
        const isCtor = ts.isConstructorDeclaration(node);
        const nameNode = nameNodeOf(node, sf);
        if (nameNode && (includeConstructors || !isCtor)) {
          const mods = modifiersOf(fn);
          const declMods = modifiersOf(node);
          const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
          const simpleName = isCtor ? 'constructor'
            : (ts.isExportAssignment(node) || (ts.isFunctionDeclaration(node) && !node.name)) ? 'default'
              : nameNode.getText(sf);
          const label = c && !enclosing ? `${c}.${simpleName}` : enclosing ? `${enclosing.label}.${simpleName}` : simpleName;
          const accessor = ts.isGetAccessorDeclaration(node) ? 'get ' : ts.isSetAccessorDeclaration(node) ? 'set ' : '';
          let key = `${accessor}${enclosing ? `${enclosing.key}>` : ''}${c && !enclosing ? `${c}.` : ''}${simpleName}`;
          // overload signatures: same name, no body -- number them in source order
          const bodyless = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !node.body;
          if (bodyless) {
            const n = (overloadSeen.get(key) || 0) + 1;
            overloadSeen.set(key, n);
            key = `${key}#overload${n}`;
          }
          const sym = {
            label,
            key,
            simpleName,
            className: c || null,
            // A helper declared inside another function is not a class member even
            // when that function is a method: it is called bare, from its own scope.
            nested: !!enclosing,
            isConstructor: isCtor,
            // The call hierarchy names code inside a constructor after its CLASS, so a
            // caller in a changed constructor is reported at the class name, not here.
            classNamePos: isCtor && cPos !== undefined ? cPos : null,
            valueLike: ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node),
            namePos: nameNode.getStart(sf),
            startLine, endLine, span: endLine - startLine,
            start: node.getStart(sf), end: node.getEnd(),
            decorators: [...decoratorsOf(node)],
            exported: declMods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || ts.isExportAssignment(node)
              || ts.isBinaryExpression(node),
            sig: {
              async: mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
              params: paramsOf(fn, sf),
              returns: fn.type ? fn.type.getText(sf).replace(/\s+/g, ' ') : null,
            },
            throws: throwsOf(fn, sf),
          };
          out.push(sym);
          nextEnclosing = { label, key };
        }
      }
      // a class declared inside a function starts a fresh member scope
      const innerEnclosing = (ts.isClassDeclaration(node) || ts.isClassExpression(node)) ? null : nextEnclosing;
      ts.forEachChild(node, (k) => visit(k, c, innerEnclosing, cPos));
    };
    ts.forEachChild(sf, (k) => visit(k, undefined, null, undefined));
    return out;
  }

  // Innermost enclosing declaration wins: smallest span containing the hunk.
  function mapHunk(callables, lo, hi) {
    let best = null;
    for (const c of callables) {
      if (c.startLine <= hi && c.endLine >= lo && (!best || c.span < best.span)) best = c;
    }
    return best;
  }

  // Every callable a changed range touches, innermost per line. One range can cover
  // several functions (an added file, two adjacent one-liners edited together), and
  // returning only the smallest silently dropped the rest.
  //
  // A pure deletion is a fractional marker `N + 0.5` -- the gap between lines N and
  // N+1. It belongs only to a callable spanning both neighbours, never to the function
  // that merely ends before it or starts after it.
  function mapRange(callables, lo, hi) {
    const bySpan = callables.slice().sort((a, b) => a.span - b.span || (a.end - a.start) - (b.end - b.start));
    const out = [];
    const add = (c) => { if (c && !out.includes(c)) out.push(c); };
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      add(bySpan.find((c) => c.startLine < lo && c.endLine > hi) || null);
      return out;
    }
    // Fast path: most ranges are a few lines. For a large one only lines where a
    // callable starts or ends can change the answer, so probe those plus the ends.
    const probes = new Set([lo, hi]);
    if (hi - lo > 64) {
      for (const c of callables) {
        for (const l of [c.startLine, c.endLine, c.endLine + 1]) if (l >= lo && l <= hi) probes.add(l);
      }
    } else {
      for (let l = lo; l <= hi; l++) probes.add(l);
    }
    for (const l of [...probes].sort((a, b) => a - b)) {
      const onLine = bySpan.filter((c) => c.startLine <= l && c.endLine >= l);
      for (const c of onLine) {
        if (!onLine.some((d) => d !== c && d.start >= c.start && d.end <= c.end && d.end - d.start < c.end - c.start)) add(c);
      }
    }
    return out;
  }

  return { collect, mapHunk, mapRange, renderSig, funcLike, modifiersOf, decoratorNodes };
}
module.exports = { makeSymbols };
