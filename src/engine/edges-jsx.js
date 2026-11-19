// @ts-check
'use strict';
// A React handler is passed, not called: `onClick={handleSubmit}`, `<form action={save}>`,
// `onSubmit={form.handleSubmit(save)}`. The call hierarchy lists no caller for it, so an
// impact walk stopped there ("referenced as a value") and a changed handler, or the server
// action it calls, never reached the page that renders it.
//
// This helper finds those uses for the impact walk only (`pathEdges`, see
// src/engine/impact-paths.js): each reference to the function that sits inside a JSX
// attribute's value becomes an edge to the function that renders the attribute. The edges
// are not callers: the caller list, test reach and the tree never see them, so a test that
// only renders a component does not cover its handler, and an answer with edges is never
// read as a complete caller list.
//
// Deps are injected, as for ./edges-cqrs.js, so one implementation serves both resolvers:
// the CLI supplies its TypeScript LanguageService's references, the editor its server's.

const path = require('path');

/** @typedef {import('./caller-contract').PathEdgeRow} PathEdgeRow */
/** @typedef {import('./caller-contract').PathEdgesAnswer} PathEdgesAnswer */
/**
 * A use of a binding of a returned value (`usesOf` in makeJsxEdges): `prop` is the member
 * used (`x.k`) when the binding is the whole object; `escape` marks the object passed on.
 * @typedef {{ prop?: string, escape?: boolean, use: ReturnType<typeof classifyBindingUse> }} BindingUse
 */

// The reason an answer with a use the helper cannot follow carries; the same words the walk
// gives a function that is only referenced as a value (impact-paths.js `topState`).
const OTHER_USE = 'referenced as a value (passed or registered), never called directly';

/**
 * The innermost node of `sf` whose span holds `offset`.
 * @param {any} sf A TypeScript SourceFile. @param {number} offset UTF-16 offset.
 * @returns {any}
 */
function nodeAt(sf, offset) {
  /** @type {any} */
  let node = sf;
  for (let next = true; next;) {
    next = false;
    node.forEachChild((/** @type {any} */ child) => {
      if (!next && child.getStart(sf) <= offset && offset < child.getEnd()) { node = child; next = true; }
    });
  }
  return node;
}

/**
 * How the reference `node` (an identifier) uses the name: `'declaration'` for an import or
 * export, which neither calls nor passes it on (`import { f }`, `import f`, `import * as f`,
 * `export { f }`, `export default f`), `'call'` for the callee of a call or `new` (`f()`,
 * `a.f()`), `'other'` for any other use.
 * @param {any} ts @param {any} node
 * @returns {'declaration'|'call'|'other'}
 */
function referenceKindOfNode(ts, node) {
  const p = node.parent;
  if (!p) return 'other';
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)
    || ts.isExportSpecifier(p) || ts.isExportAssignment(p)) return 'declaration';
  const callee = ts.isPropertyAccessExpression(p) && p.name === node ? p : node;
  const q = callee.parent;
  return q && (ts.isCallExpression(q) || ts.isNewExpression(q)) && q.expression === callee ? 'call' : 'other';
}

/**
 * The JSX attribute whose value holds `node`, or null. Any depth inside the value counts
 * (`onClick={f}`, `onClick={ cond ? f : g }`, `onSubmit={form.handleSubmit(f)}`); a spread
 * (`{...handlers}`) and a child expression (`<X>{f}</X>`) are not attribute values.
 * @param {any} ts @param {any} node
 * @returns {any}
 */
function jsxAttributeOf(ts, node) {
  for (let k = node.parent; k && !ts.isSourceFile(k); k = k.parent) {
    if (ts.isJsxAttribute(k)) return k.initializer && ts.isJsxExpression(k.initializer) ? k : null;
    // Past the attribute list or an element, the reference is not in an attribute value.
    if (ts.isJsxAttributes(k) || ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k) || ts.isJsxFragment(k)) return null;
  }
  return null;
}

/**
 * The function the call hierarchy names as the one holding `node`, with its label and the
 * position of its name: the same rule TypeScript's call hierarchy applies to a call there,
 * so the walk's de-duplication (by file and position) and entry detection see one node.
 * A named function, method or accessor, a function or class expression with a name, or an
 * arrow or function expression assigned to a variable or class field; an anonymous callback
 * belongs to the declaration around it. `export default function () {}` is `default` at its
 * `default` keyword; code in no such declaration (module scope, `export default () => …`,
 * `memo(() => …)`) is the module: the file's name at offset 0, as the call hierarchy names it.
 * @param {any} ts @param {any} sf @param {any} node
 * @returns {{ label: string, pos: number }}
 */
function enclosingDeclaration(ts, sf, node) {
  const classPrefix = (/** @type {any} */ member) => {
    const c = member.parent;
    return c && (ts.isClassDeclaration(c) || ts.isClassExpression(c)) && c.name ? `${c.name.text}.` : '';
  };
  for (let k = node.parent; k && !ts.isSourceFile(k); k = k.parent) {
    if (ts.isFunctionDeclaration(k)) {
      if (k.name) return { label: k.name.text, pos: k.name.getStart(sf) };
      const dflt = (k.modifiers || []).find((/** @type {any} */ m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (dflt) return { label: 'default', pos: dflt.getStart(sf) };
      continue;
    }
    if ((ts.isMethodDeclaration(k) || ts.isGetAccessorDeclaration(k) || ts.isSetAccessorDeclaration(k)) && k.name) {
      return { label: `${classPrefix(k)}${k.name.getText(sf)}`, pos: k.name.getStart(sf) };
    }
    if (ts.isConstructorDeclaration(k) && k.parent && k.parent.name) return { label: k.parent.name.text, pos: k.parent.name.getStart(sf) };
    if ((ts.isFunctionExpression(k) || ts.isClassExpression(k)) && k.name) return { label: k.name.text, pos: k.name.getStart(sf) };
    if (ts.isArrowFunction(k) || ts.isFunctionExpression(k)) {
      const p = k.parent;
      if (p && ts.isVariableDeclaration(p) && p.initializer === k && ts.isIdentifier(p.name)) return { label: p.name.text, pos: p.name.getStart(sf) };
      if (p && ts.isPropertyDeclaration(p) && p.initializer === k && p.name) return { label: `${classPrefix(p)}${p.name.getText(sf)}`, pos: p.name.getStart(sf) };
    }
  }
  return { label: path.basename(sf.fileName), pos: 0 };
}

/**
 * How one reference uses the function, for the impact walk.
 * - `{ kind: 'edge', prop, element, owner }`: inside a JSX attribute's value and not called
 *   there; `owner` is the function that renders the attribute.
 * - `'declaration'`: an import or export, neutral.
 * - `'call'` or `'other'`: anything else (`setTimeout(f)`, `{ onClick: f }`, `<X>{f}</X>`).
 * @param {any} ts @param {any} sf @param {number} offset UTF-16 offset of the reference.
 * @returns {{ kind: 'edge', prop: string, element: string, owner: { label: string, pos: number }, start: number, end: number } | { kind: 'declaration'|'call'|'other' }}
 */
function classifyReference(ts, sf, offset) {
  const node = nodeAt(sf, offset);
  if (!ts.isIdentifier(node)) return { kind: 'other' };
  const kind = referenceKindOfNode(ts, node);
  if (kind !== 'other') return { kind };
  const attr = jsxAttributeOf(ts, node);
  if (!attr) return { kind: 'other' };
  const opening = attr.parent && attr.parent.parent;
  const element = opening && opening.tagName ? opening.tagName.getText(sf) : '?';
  return { kind: 'edge', prop: attr.name.getText(sf), element, owner: enclosingDeclaration(ts, sf, attr), start: attr.getStart(sf), end: attr.getEnd() };
}

// Functions returned by a named function: `return { f }`, consumed as `const { f } = useX()`.
// Nothing calls `f` by its name; its consumers use a binding of what useX returned. Each use
// of that binding that calls it, renders it as a JSX tag or passes it in a JSX attribute is a
// walk-only edge from `f` to the function holding the use. The consumers are found from the
// call sites of useX itself, never from references to the property: two functions returning
// one interface share the property, so its references would join unrelated consumers.

// The most call sites of one returning function that are classified; past it, incomplete.
const MAX_RETURN_SITES = 30;

/** The node `e` is wrapped in by `(e)`, `e as T`, `e satisfies T` or `e!`, which leave its value as it is. @param {any} ts @param {any} e */
function outerOf(ts, e) {
  let k = e;
  while (k.parent && (ts.isParenthesizedExpression(k.parent) || ts.isAsExpression(k.parent)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(k.parent)) || ts.isNonNullExpression(k.parent))) k = k.parent;
  return k;
}

/**
 * The name of a function a caller calls it by, or null: a named function declaration, a
 * class method, or an arrow or function expression assigned to a variable.
 * @param {any} ts @param {any} sf @param {any} fn A function-like node.
 * @returns {{ label: string, pos: number } | null}
 */
function namedFunction(ts, sf, fn) {
  if (ts.isFunctionDeclaration(fn)) return fn.name ? { label: fn.name.text, pos: fn.name.getStart(sf) } : null;
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) {
    const c = fn.parent;
    const prefix = c && (ts.isClassDeclaration(c) || ts.isClassExpression(c)) && c.name ? `${c.name.text}.` : '';
    return { label: `${prefix}${fn.name.text}`, pos: fn.name.getStart(sf) };
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && p.initializer === fn && ts.isIdentifier(p.name)) return { label: p.name.text, pos: p.name.getStart(sf) };
  }
  return null;
}

/**
 * The named function that returns the reference `node` as a property of an object literal
 * (`return { f }`, `return { k: f }`, `() => ({ f })`), with the property's key; else null.
 * The function that owns the `return` must itself be named (see namedFunction):
 * `useMemo(() => ({ f }))` and `.map(() => ({ onClick: f }))` are anonymous callbacks, and
 * `enclosingDeclaration`, which climbs past them, is not asked.
 * @param {any} ts @param {any} sf @param {any} node An identifier.
 * @returns {{ key: string, hook: { label: string, pos: number } } | null}
 */
function returnedMemberOf(ts, sf, node) {
  const p = node.parent;
  const prop = p && ((ts.isShorthandPropertyAssignment(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.initializer === node)) ? p : null;
  if (!prop || !ts.isObjectLiteralExpression(prop.parent)) return null;
  if (!(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) return null;
  const literal = outerOf(ts, prop.parent);
  const holder = literal.parent;
  /** @type {any} */
  let fn = null;
  if (holder && ts.isReturnStatement(holder)) {
    for (let k = holder.parent; k && !ts.isSourceFile(k); k = k.parent) if (ts.isFunctionLike(k)) { fn = k; break; }
  } else if (holder && ts.isArrowFunction(holder) && holder.body === literal) fn = holder;
  const hook = fn ? namedFunction(ts, sf, fn) : null;
  return hook ? { key: prop.name.text, hook } : null;
}

/**
 * The span a binding declared by `decl` (a VariableDeclaration) is visible in: the nearest
 * block, function or file around it.
 * @param {any} ts @param {any} decl @returns {{ start: number, end: number }}
 */
function scopeOf(ts, decl) {
  for (let k = decl.parent; k; k = k.parent) {
    if (ts.isBlock(k) || ts.isSourceFile(k) || ts.isModuleBlock(k) || ts.isCaseBlock(k) || ts.isFunctionLike(k)) return { start: k.pos, end: k.end };
  }
  return { start: 0, end: Number.MAX_SAFE_INTEGER };
}

/**
 * What one reference to a returning function does with the object the call returns.
 * - `'neutral'`: an import or export, or a call whose result is dropped (`useX();`).
 * - `'destructure'`: `const { k, k: g } = useX()` with no rest element; `bindings` maps each
 *   key to its binding's name position, or to null when the binding is itself a pattern.
 * - `'object'`: `const x = useX()`; `pos` is the position of `x`.
 * - `'escape'`: anything else (an argument, a spread, a rest element, a return, a type
 *   annotation such as `any`, `await`, stored, or the function passed as a value).
 * @param {any} ts @param {any} sf @param {number} offset UTF-16 offset of the reference.
 * @returns {{ kind: 'neutral'|'escape' } | { kind: 'destructure', bindings: Map<string, number|null>, scope: { start: number, end: number } } | { kind: 'object', pos: number, scope: { start: number, end: number } }}
 */
function classifyReturnSite(ts, sf, offset) {
  const node = nodeAt(sf, offset);
  if (!ts.isIdentifier(node)) return { kind: 'escape' };
  const kind = referenceKindOfNode(ts, node);
  if (kind === 'declaration') return { kind: 'neutral' };
  if (kind !== 'call') return { kind: 'escape' };
  const callee = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
  const call = callee.parent;
  const decl = call.parent;
  if (decl && ts.isExpressionStatement(decl)) return { kind: 'neutral' };
  if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer !== call || decl.type) return { kind: 'escape' };
  if (ts.isIdentifier(decl.name)) return { kind: 'object', pos: decl.name.getStart(sf), scope: scopeOf(ts, decl) };
  if (!ts.isObjectBindingPattern(decl.name)) return { kind: 'escape' };
  /** @type {Map<string, number|null>} */
  const bindings = new Map();
  for (const el of decl.name.elements) {
    if (el.dotDotDotToken) return { kind: 'escape' };
    const keyNode = el.propertyName || el.name;
    if (!(ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode))) return { kind: 'escape' };
    bindings.set(keyNode.text, ts.isIdentifier(el.name) ? el.name.getStart(sf) : null);
  }
  return { kind: 'destructure', bindings, scope: scopeOf(ts, decl) };
}

/** Whether `arr` is the dependency array of a hook call: the last of two or more arguments of a `use*` call (`useCallback(f, [a])`). @param {any} ts @param {any} arr */
function isDepsArray(ts, arr) {
  const call = arr.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments.length < 2 || call.arguments[call.arguments.length - 1] !== arr) return false;
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  return ts.isIdentifier(callee) && /^use[A-Z]/.test(callee.text);
}

/**
 * How a use of a returned value is followed: `node` is a reference to the binding `g` of
 * `const { f: g } = useX()`, or the name `f` of `x.f` for `const x = useX()`.
 * - `{ kind: 'edge', owner }`: called, rendered as a JSX tag, or in a JSX attribute's value;
 *   `owner` is the function holding the use, as the call hierarchy names it (a use inside
 *   `useCallback(() => …)` belongs to the component).
 * - `'neutral'`: an import or export, a closing JSX tag, or an element of a hook's
 *   dependency array, which neither calls it nor passes it on.
 * - `'other'`: anything else (`useRef(g)`, stored, returned, passed as an argument).
 * @param {any} ts @param {any} sf @param {any} node
 * @returns {{ kind: 'edge', owner: { label: string, pos: number }, start: number, end: number } | { kind: 'neutral'|'other' }}
 */
function classifyBindingUse(ts, sf, node) {
  const kind = referenceKindOfNode(ts, node);
  if (kind === 'declaration') return { kind: 'neutral' };
  if (kind === 'call') return { kind: 'edge', owner: enclosingDeclaration(ts, sf, node), start: node.getStart(sf), end: node.getEnd() };
  const value = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
  const p = value.parent;
  if (p && (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === value) {
    return { kind: 'edge', owner: enclosingDeclaration(ts, sf, p), start: p.getStart(sf), end: p.getEnd() };
  }
  if (p && ts.isJsxClosingElement(p)) return { kind: 'neutral' };
  if (p && ts.isArrayLiteralExpression(p) && isDepsArray(ts, p)) return { kind: 'neutral' };
  const attr = jsxAttributeOf(ts, value);
  if (attr) return { kind: 'edge', owner: enclosingDeclaration(ts, sf, attr), start: attr.getStart(sf), end: attr.getEnd() };
  return { kind: 'other' };
}

/**
 * Whether the reference `node` names something other than the binding it was asked for: a
 * property of another object (`y.k`, `{ k: 1 }`, a type member) or another destructuring's
 * key. A query at a shorthand binding (`const { k } = useX()`) also lists the property `k`.
 * @param {any} ts @param {any} node
 */
function isForeignName(ts, node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isBindingElement(p)) return p.name === node || p.propertyName === node;
  if (ts.isPropertyAccessExpression(p)) return p.name === node;
  if (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodSignature(p) || ts.isMethodDeclaration(p)) return p.name === node;
  return false;
}

/**
 * @param {any} ts The TypeScript compiler module.
 * @param {object} deps
 * @param {(file: string, pos: number) => Promise<{ refs: Array<{ file: string, start: number }>, failed: boolean, reason?: string }>} deps.referencesTo
 *   Every reference to the symbol whose name is at `pos` in `file`, declarations included or
 *   not. `failed`: a query failed, so the list may be short (`reason` says why).
 * @param {(file: string) => string|null} deps.readText The text the reference offsets index,
 *   or null when it cannot be read.
 * @param {(file: string) => boolean} deps.isTestPath
 * @param {(message: string) => void} [deps.trace]
 */
function makeJsxEdges(ts, { referencesTo, readText, isTestPath, trace = () => {} }) {
  // Cache: parsed source files. Owner: this helper; the CLI owns one per project resolver,
  // the editor one per analysis generation (its extras replace it on clear()). Key: file
  // path, checked against the text read now (a file that changed is parsed again). Disposal:
  // with the helper. Holds at most the files that hold a reference the walk asked about.
  /** @type {Map<string, { text: string, sf: any }>} */
  const parsed = new Map();
  /** @param {string} file @returns {any} */
  function sourceOf(file) {
    const text = readText(file);
    if (typeof text !== 'string') return null;
    const hit = parsed.get(file);
    if (hit && hit.text === text) return hit.sf;
    let sf;
    try { sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true); } catch { return null; }
    parsed.set(file, { text, sf });
    return sf;
  }

  // Cache: answers. Owner and disposal as for `parsed`. Key: file#position of the function.
  // Files are assumed not to change while one owner lives (an analysis run, or one editor
  // analysis generation). An answer whose references query failed or threw is never stored.
  /** @type {Map<string, PathEdgesAnswer>} */
  const answers = new Map();

  // Caches for returned functions, owner and disposal as for `answers`: the classified
  // references of a returning function (key: file#position of its name; the members of one
  // hook share them), and the uses of a binding of what it returns (key: file#position of the
  // binding). Nothing is stored when its references query failed or threw.
  /** @type {Map<string, { sites: Array<{ file: string, site: ReturnType<typeof classifyReturnSite> }> }>} */
  const returnSites = new Map();
  /** @type {Map<string, { uses: BindingUse[] }>} */
  const bindingUses = new Map();

  /**
   * Every reference to `file`@`pos` once (an editor's list is flat: one location can come
   * twice), less the name at `pos` and test files.
   * @param {string} file @param {number} pos
   * @returns {Promise<{ refs: Array<{ file: string, start: number }>, failed: string|null }>}
   */
  async function productionRefs(file, pos) {
    let found;
    try {
      found = await referencesTo(file, pos);
    } catch (e) {
      return { refs: [], failed: `its references could not be listed: ${(e && /** @type {Error} */ (e).message) || 'lookup failed'}` };
    }
    const seen = new Set();
    const refs = [];
    for (const ref of found.refs) {
      const key = `${ref.file}#${ref.start}`;
      if (seen.has(key) || (ref.file === file && ref.start === pos) || isTestPath(ref.file)) continue;
      seen.add(key);
      refs.push(ref);
    }
    return { refs, failed: found.failed ? (found.reason || 'a references query failed: uses may be missing') : null };
  }

  /**
   * The references to the returning function whose name is at `pos`, each classified
   * (classifyReturnSite). Test files are left out (tests are not walked).
   * @param {string} file @param {number} pos
   */
  async function returnSitesOf(file, pos) {
    const key = `${file}#${pos}`;
    const hit = returnSites.get(key);
    if (hit) return { ...hit, failed: null };
    const { refs, failed } = await productionRefs(file, pos);
    const sites = refs.map((ref) => {
      const sf = sourceOf(ref.file);
      /** @type {ReturnType<typeof classifyReturnSite>} */
      const site = sf ? classifyReturnSite(ts, sf, ref.start) : { kind: 'escape' };
      return { file: ref.file, site };
    });
    if (!failed) returnSites.set(key, { sites });
    return { sites, failed };
  }

  /**
   * The uses of the binding whose name is at `pos` in `file`, within `scope`. With `members`
   * (`const x = useX()`), each use is expected as `x.k` (`prop`: k); any other use of `x`
   * passes the object on (`escape`), except in a hook's dependency array.
   * @param {string} file @param {number} pos @param {{ start: number, end: number }} scope @param {boolean} members
   * @returns {Promise<{ uses: BindingUse[], failed: string|null }>}
   */
  async function usesOf(file, pos, scope, members) {
    const key = `${file}#${pos}`;
    const hit = bindingUses.get(key);
    if (hit) return { ...hit, failed: null };
    const { refs, failed } = await productionRefs(file, pos);
    const sf = sourceOf(file);
    /** @type {BindingUse[]} */
    const uses = [];
    for (const ref of refs) {
      // A query at a shorthand binding lists the property too: its uses elsewhere are not this binding's.
      if (ref.file !== file || ref.start < scope.start || ref.start >= scope.end) continue;
      const node = sf ? nodeAt(sf, ref.start) : null;
      if (!node || !ts.isIdentifier(node)) { uses.push({ use: { kind: 'other' } }); continue; }
      if (!members) {
        if (!isForeignName(ts, node)) uses.push({ use: classifyBindingUse(ts, sf, node) });
        continue;
      }
      const p = node.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.expression === node) { uses.push({ prop: p.name.text, use: classifyBindingUse(ts, sf, p.name) }); continue; }
      const use = classifyBindingUse(ts, sf, node);
      uses.push(use.kind === 'neutral' ? { use } : { escape: true, use: { kind: 'other' } });
    }
    if (!failed) bindingUses.set(key, { uses });
    return { uses, failed };
  }

  /**
   * The walk-only edges of a function returned as property `key` by `hook` (declared in
   * `hookFile`), added to `rows`; each use that is not followed adds a reason to `reasons`.
   * @param {string} hookFile @param {{ label: string, pos: number }} hook @param {string} key
   * @param {Map<string, PathEdgeRow>} rows @param {Set<string>} reasons
   * @returns {Promise<boolean>} Whether every query answered (the answer may be stored).
   */
  async function returnedMemberEdges(hookFile, hook, key, rows, reasons) {
    let answered = true;
    const passedOn = (/** @type {string} */ f) => reasons.add(`the object ${hook.label} returns is passed on in ${path.basename(f)}`);
    const { sites, failed } = await returnSitesOf(hookFile, hook.pos);
    if (failed) { reasons.add(failed); answered = false; }
    const followed = sites.filter((s) => s.site.kind !== 'neutral');
    if (followed.length > MAX_RETURN_SITES) reasons.add(`${hook.label} has more than ${MAX_RETURN_SITES} call sites: only ${MAX_RETURN_SITES} were followed`);
    for (const { file, site } of followed.slice(0, MAX_RETURN_SITES)) {
      /** @type {{ uses: BindingUse[], failed: string|null }} */
      let found;
      if (site.kind === 'destructure') {
        if (!site.bindings.has(key)) continue;
        const at = site.bindings.get(key);
        if (at == null) { passedOn(file); continue; }
        found = await usesOf(file, at, site.scope, false);
      } else if (site.kind === 'object') {
        found = await usesOf(file, site.pos, site.scope, true);
      } else { passedOn(file); continue; }
      if (found.failed) { reasons.add(found.failed); answered = false; }
      for (const u of found.uses) {
        if (u.escape) { passedOn(file); continue; }
        if (u.prop !== undefined && u.prop !== key) continue;
        if (u.use.kind === 'neutral') continue;
        if (u.use.kind !== 'edge') { reasons.add(`${key} returned by ${hook.label} is used as a value in ${path.basename(file)}`); continue; }
        const edge = /** @type {Extract<BindingUse['use'], { kind: 'edge' }>} */ (u.use);
        const rowKey = `${file}#${edge.owner.pos}`;
        const row = rows.get(rowKey);
        if (row) {
          row.callSites.push({ start: edge.start, end: edge.end });
          row.sites = row.callSites.length;
          continue;
        }
        rows.set(rowKey, {
          label: edge.owner.label, file, pos: edge.owner.pos, test: false, sites: 1,
          callSites: [{ start: edge.start, end: edge.end }],
          via: 'returned-member', text: `returned by ${hook.label}, used in ${edge.owner.label}`,
        });
      }
    }
    return answered;
  }

  /**
   * Walk-only edges of the function whose name is at `pos` in `file`: one row per function
   * that passes it in a JSX attribute's value, or uses it where a named function returns it
   * in an object literal (`via: 'returned-member'`), de-duplicated by the row's file and
   * position. `complete` is true only when every production reference is such an edge, an
   * import or an export, and every call site of a returning function was followed;
   * `returnedBy` names the returning functions. References in test files are left out
   * (tests are not walked). Never rejects.
   * @param {string} file Absolute path. @param {number} pos UTF-16 offset of the name.
   * @returns {Promise<PathEdgesAnswer>}
   */
  async function pathEdges(file, pos) {
    const cached = answers.get(`${file}#${pos}`);
    if (cached) return cached;
    let found;
    try {
      found = await referencesTo(file, pos);
    } catch (e) {
      return { rows: [], complete: false, reason: `its references could not be listed: ${(e && /** @type {Error} */ (e).message) || 'lookup failed'}` };
    }
    /** @type {Map<string, PathEdgeRow>} */
    const rows = new Map();
    /** @type {string|null} */
    let other = null;
    // Returned as a property by a named function: followed through its call sites below.
    /** @type {Map<string, { file: string, key: string, hook: { label: string, pos: number } }>} */
    const returned = new Map();
    for (const ref of found.refs) {
      if (ref.file === file && ref.start === pos) continue; // the declaration's name
      if (isTestPath(ref.file)) continue;
      const sf = sourceOf(ref.file);
      // A reference that cannot be placed is a use the walk cannot follow.
      const use = sf ? classifyReference(ts, sf, ref.start) : { kind: 'other' };
      if (use.kind === 'declaration') continue;
      const member = use.kind === 'other' && sf ? returnedMemberOf(ts, sf, nodeAt(sf, ref.start)) : null;
      if (member) {
        returned.set(`${ref.file}#${member.hook.pos}#${member.key}`, { file: ref.file, ...member });
        continue;
      }
      if (use.kind !== 'edge') {
        // A call the call hierarchy did not list is no edge either: the answer stays unknown.
        if (!other) other = path.basename(ref.file);
        continue;
      }
      const edge = /** @type {Extract<ReturnType<typeof classifyReference>, { kind: 'edge' }>} */ (use);
      const key = `${ref.file}#${edge.owner.pos}`;
      const row = rows.get(key);
      if (row) {
        row.callSites.push({ start: edge.start, end: edge.end });
        row.sites = row.callSites.length;
        continue;
      }
      rows.set(key, {
        label: edge.owner.label, file: ref.file, pos: edge.owner.pos, test: false, sites: 1,
        callSites: [{ start: edge.start, end: edge.end }],
        via: 'jsx-prop', text: `passed as ${edge.prop} to <${edge.element}>`,
      });
    }
    /** @type {Set<string>} */
    const memberReasons = new Set();
    let answered = true;
    for (const r of returned.values()) {
      if (!(await returnedMemberEdges(r.file, r.hook, r.key, rows, memberReasons))) answered = false;
    }
    trace(`jsx edges of ${path.basename(file)}@${pos}: ${rows.size} edge(s)${other ? `, another use in ${other}` : ''}${found.failed ? ', a references query failed' : ''}${returned.size ? `, returned by ${[...returned.values()].map((r) => r.hook.label).join(', ')}` : ''}`);
    const reasons = [];
    if (found.failed) reasons.push(found.reason || 'a references query failed: uses may be missing');
    if (other) reasons.push(`${OTHER_USE} (in ${other})`);
    reasons.push(...memberReasons);
    /** @type {PathEdgesAnswer} */
    const answer = reasons.length ? { rows: [...rows.values()], complete: false, reason: reasons.join('; ') } : { rows: [...rows.values()], complete: true };
    if (returned.size) answer.returnedBy = [...new Set([...returned.values()].map((r) => r.hook.label))].join(', ');
    if (!found.failed && answered) answers.set(`${file}#${pos}`, answer);
    return answer;
  }

  return { pathEdges };
}

module.exports = { makeJsxEdges, classifyReference, referenceKindOfNode, nodeAt, enclosingDeclaration, returnedMemberOf, classifyReturnSite, classifyBindingUse };
