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

  /**
   * Walk-only edges of the function whose name is at `pos` in `file`: one row per function
   * that passes it in a JSX attribute's value, de-duplicated by the row's file and position.
   * `complete` is true only when every production reference is such an edge, an import or
   * an export; references in test files are left out (tests are not walked). Never rejects.
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
    for (const ref of found.refs) {
      if (ref.file === file && ref.start === pos) continue; // the declaration's name
      if (isTestPath(ref.file)) continue;
      const sf = sourceOf(ref.file);
      // A reference that cannot be placed is a use the walk cannot follow.
      const use = sf ? classifyReference(ts, sf, ref.start) : { kind: 'other' };
      if (use.kind === 'declaration') continue;
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
    trace(`jsx edges of ${path.basename(file)}@${pos}: ${rows.size} edge(s)${other ? `, another use in ${other}` : ''}${found.failed ? ', a references query failed' : ''}`);
    const reasons = [];
    if (found.failed) reasons.push(found.reason || 'a references query failed: uses may be missing');
    if (other) reasons.push(`${OTHER_USE} (in ${other})`);
    /** @type {PathEdgesAnswer} */
    const answer = reasons.length ? { rows: [...rows.values()], complete: false, reason: reasons.join('; ') } : { rows: [...rows.values()], complete: true };
    if (!found.failed) answers.set(`${file}#${pos}`, answer);
    return answer;
  }

  return { pathEdges };
}

module.exports = { makeJsxEdges, classifyReference, referenceKindOfNode, nodeAt, enclosingDeclaration };
