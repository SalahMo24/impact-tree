'use strict';
// Find the binding visible at a use, not the first same-named declaration in a file.
// The result is the declaring node: a parameter, variable declaration, binding element,
// function, class, enum or namespace declaration, or a catch variable. `null` means no
// enclosing scope declares `name`, so the use refers to an import or a global. Every
// shadowing form must be seen here: a missed local lets the caller resolve an import of
// the same name and report a call that never reaches it.

// Names declared by one scope node, computed once per node: bindingAt runs per call site.
const scopeNames = new WeakMap();

function isBlockScoped(ts, list) {
  return (list.flags & ts.NodeFlags.BlockScoped) !== 0;
}

function isScope(ts, node) {
  return ts.isFunctionLike(node) || ts.isClassExpression(node) || ts.isBlock(node) || ts.isSourceFile(node)
    || ts.isModuleBlock(node) || isStaticBlock(ts, node) || ts.isCaseBlock(node) || ts.isForStatement(node)
    || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node);
}

function namesOf(ts, scope) {
  let names = scopeNames.get(scope);
  if (names) return names;
  names = new Map();
  const add = (text, node) => { if (!names.has(text)) names.set(text, node); };
  // `{ a: { Store } }` and `[, Store]` declare Store as a binding element.
  const addBinding = (nameNode, owner) => {
    if (ts.isIdentifier(nameNode)) { add(nameNode.text, owner); return; }
    for (const el of nameNode.elements) {
      if (!ts.isOmittedExpression(el)) addBinding(el.name, el);
    }
  };
  const addStatements = (statements) => {
    for (const s of statements) {
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) addBinding(d.name, d);
      } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)
        || ts.isModuleDeclaration(s)) && s.name && ts.isIdentifier(s.name)) {
        add(s.name.text, s);
      }
    }
  };
  // `var` belongs to the nearest function, static block, namespace or file, even when it
  // is declared inside a nested block or loop header.
  const addHoistedVars = (root) => {
    const stack = [];
    ts.forEachChild(root, (k) => { stack.push(k); });
    while (stack.length) {
      const n = stack.pop();
      if (ts.isFunctionLike(n) || ts.isModuleBlock(n) || isStaticBlock(ts, n)) continue;
      if (ts.isVariableDeclarationList(n) && !isBlockScoped(ts, n)) {
        for (const d of n.declarations) addBinding(d.name, d);
      }
      ts.forEachChild(n, (k) => { stack.push(k); });
    }
  };

  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters || []) addBinding(p.name, p);
    // A named function expression can refer to itself by that name.
    if (ts.isFunctionExpression(scope) && scope.name) add(scope.name.text, scope);
    if (scope.body) addHoistedVars(scope.body);
  }
  if (ts.isClassExpression(scope) && scope.name) add(scope.name.text, scope);
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) addStatements(scope.statements);
  if (ts.isSourceFile(scope) || ts.isModuleBlock(scope) || isStaticBlock(ts, scope)) addHoistedVars(scope);
  // Every clause of a switch shares one scope: a `const` in `case 1:` is visible in `case 2:`.
  if (ts.isCaseBlock(scope)) for (const clause of scope.clauses) addStatements(clause.statements);
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
    && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    for (const d of scope.initializer.declarations) addBinding(d.name, d);
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) addBinding(scope.variableDeclaration.name, scope.variableDeclaration);

  scopeNames.set(scope, names);
  return names;
}

function isStaticBlock(ts, node) {
  return typeof ts.isClassStaticBlockDeclaration === 'function' && ts.isClassStaticBlockDeclaration(node);
}

function bindingAt(ts, use, name) {
  for (let scope = use.parent; scope; scope = scope.parent) {
    if (!isScope(ts, scope)) continue;
    const hit = namesOf(ts, scope).get(name);
    if (hit) return hit;
  }
  return null;
}
module.exports = { bindingAt };
