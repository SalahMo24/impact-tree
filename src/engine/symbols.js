'use strict';

function makeSymbols(ts) {
  const funcLike = (n) => {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) return n;
    if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.initializer;
    return null;
  };

  const decoratorsOf = (n) => (ts.canHaveDecorators(n) ? ts.getDecorators(n) || [] : [])
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
  function collect(sf, { includeConstructors = true } = {}) {
    const out = [];
    const visit = (node, cls) => {
      let c = cls;
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) c = node.name.text;
      const fn = funcLike(node);
      if (fn) {
        const isCtor = ts.isConstructorDeclaration(node);
        const nameNode = isCtor ? node.getFirstToken(sf) : node.name;
        if (nameNode && (includeConstructors || !isCtor)) {
          const mods = ts.canHaveModifiers(fn) ? ts.getModifiers(fn) || [] : [];
          const declMods = ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : [];
          const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
          out.push({
            label: c ? `${c}.${nameNode.getText(sf)}` : nameNode.getText(sf),
            simpleName: nameNode.getText(sf),
            className: c || null,
            isConstructor: isCtor,
            valueLike: ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node),
            namePos: nameNode.getStart(sf),
            startLine, endLine, span: endLine - startLine,
            decorators: [...decoratorsOf(node), ...(c ? [] : [])],
            exported: declMods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
            sig: {
              async: mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
              params: paramsOf(fn, sf),
              returns: fn.type ? fn.type.getText(sf).replace(/\s+/g, ' ') : null,
            },
            throws: throwsOf(fn, sf),
          });
        }
      }
      ts.forEachChild(node, (k) => visit(k, c));
    };
    ts.forEachChild(sf, (k) => visit(k, undefined));
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

  return { collect, mapHunk, renderSig, funcLike };
}
module.exports = { makeSymbols };
