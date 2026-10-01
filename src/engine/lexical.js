'use strict';
// Find the binding visible at a use, not the first same-named declaration in a file.
function bindingAt(ts, use, name) {
  for (let scope = use.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const param = (scope.parameters || []).find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (param) return param;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const d of statement.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name) return d;
            if (!ts.isIdentifier(d.name)) {
              for (const el of d.name.elements || []) if (el.name && ts.isIdentifier(el.name) && el.name.text === name) return el;
            }
          }
        }
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      }
    }
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      const d = scope.initializer.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
      if (d) return d;
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration?.name?.text === name) return scope.variableDeclaration;
  }
  return null;
}
module.exports = { bindingAt };
