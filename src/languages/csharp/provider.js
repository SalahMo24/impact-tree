// @ts-check
'use strict';
// C# as a language provider (Part C, C3). Symbols come from the text outline
// (`csharpOutline`, ./outline.js, shaped as a language server's document symbols) in every
// environment (C-D3/C-D4: the editor's Roslyn server is asked only for callers, from C5), read
// through the shared `prepareFromServerSymbols` (../server-symbols.js). What is C#'s own here:
// which outline symbols are changed-symbol candidates and how they are keyed
// (`collectCsharpSymbols`, keys from ./keys.js), how an overload whose parameter list changed
// is paired with its old self (`pairCsharpOverloads`, J-D3), the header parser and kinds
// (./signature.js, C2) and which project a file belongs to (`csharpProjectOf`, ./rules.js).
//
// Until C5 (editor callers) and C8a (a syntax index) callers are not computed: every unit's
// resolver is src/engine/resolver-not-computed.js's, so no answer reads as "no callers".
// `needsServer` is false and `prepare` and `prepareSyntactic` are the same outline path: the
// editor, the CLI and the no-checkout preview list the same changed members and kinds.
//
// Engine modules are required where they are used: the registry (../index.js) loads this file,
// and src/engine/diff.js loads the registry.

const path = require('path');
const { csharpRules, csharpProjectOf } = require('./rules');
const { csharpKeyOf, overloadNameOf } = require('./keys');
const { lineStartsOf, lineOf } = require('../text');

/** @typedef {import('../types').CollectedSymbol} CollectedSymbol */
/** @typedef {import('./outline').CsharpSymbol} CsharpSymbol */

/**
 * A C# member as a changed-symbol candidate: a `CollectedSymbol` plus what `csharpKindsOf`
 * reads (`header`, `modifiers`, `inInterface`, `explicitInterface`) and the oracle's member
 * kind (`csharpKind`). `modifiers` is absent for a primary constructor and top-level
 * statements (no access to compare).
 * @typedef {CollectedSymbol & { header: string, className: string|null, nested: false,
 *   valueLike: false, decorators: string[], classNamePos: null, modifiers?: string[],
 *   inInterface: boolean, explicitInterface: string|null, csharpKind: string }} CsharpCollected
 */

/** @returns {typeof import('./signature')} */
const parser = () => require('./signature');

const TYPE_KINDS = new Set([5, 10, 11, 23]); // Class, Enum, Interface, Struct

/**
 * The changed-symbol candidates of one side of a C# file: every member the outline lists
 * (C-D4), keyed `Outer<1>.Inner.Name(T1, T2)` (C-D6, ./keys.js), a repeat of a key `#2`,
 * `#3` in source order across the file (partial declarations of one type share one key
 * space, as the syntax oracle). `label` is the key without the repeat number, a constructor
 * shown `new Type(T1)`; top-level statements are keyed and labelled with the file's basename.
 * `start`/`end` are Roslyn's `Span` (attributes in, doc comments out), `namePos` the name.
 * `sig`, `throws`, `modifiers` and `decorators` (attributes) come from the header parser.
 * `exported`: `public` or `protected`, a member of an interface or an explicit implementation.
 * Pure. Throws RangeError for a range outside `text`.
 * @param {CsharpSymbol[]} symbols `csharpOutline`'s answer for `text`.
 * @param {string} text
 * @returns {CsharpCollected[]}
 */
function collectCsharpSymbols(symbols, text) {
  const starts = lineStartsOf(text);
  const p = parser();
  /** @type {Array<{ s: CsharpSymbol, path: string[] }>} */
  const members = [];
  /** @param {CsharpSymbol[]} list @param {string[]} typePath */
  const walk = (list, typePath) => {
    for (const s of list) {
      if (s.csharp) members.push({ s, path: typePath });
      else if (TYPE_KINDS.has(s.kind)) walk(/** @type {CsharpSymbol[]} */ (s.children || []), [...typePath, s.name]);
    }
  };
  walk(symbols, []);
  members.sort((a, b) => a.s.range.start - b.s.range.start);
  /** @type {Map<string, number>} */
  const seen = new Map();
  return members.map(({ s, path: typePath }) => {
    const info = /** @type {import('./outline').CsharpMemberInfo} */ (s.csharp);
    const { start, end } = s.range;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= text.length)) {
      throw new RangeError(`C# symbol ${s.name}: range ${start}..${end} is outside its text (length ${text.length})`);
    }
    const baseKey = info.member === 'top-level' ? s.name : csharpKeyOf(typePath, s.name);
    const n = (seen.get(baseKey) || 0) + 1;
    seen.set(baseKey, n);
    const decl = info.decl;
    const isConstructor = info.member === 'constructor' || info.member === 'primary-constructor';
    const declText = text.slice(start, end);
    const startLine = lineOf(starts, start);
    const endLine = lineOf(starts, end);
    const typeLabel = typePath.join('.');
    const modifiers = decl ? decl.modifiers : null;
    const exported = info.inInterface || !!(decl && decl.explicitInterface)
      || !!(modifiers && (modifiers.includes('public') || modifiers.includes('protected')));
    return {
      label: isConstructor ? `new ${typeLabel}${baseKey.slice(baseKey.lastIndexOf('<init>(') + 6)}` : baseKey,
      key: n === 1 ? baseKey : `${baseKey}#${n}`,
      simpleName: decl ? decl.name : info.typeName || s.name,
      className: info.typeName,
      nested: /** @type {false} */ (false),
      isConstructor,
      classNamePos: null,
      valueLike: /** @type {false} */ (false),
      namePos: s.selectionRange.start,
      startLine, endLine, span: endLine - startLine,
      start, end,
      decorators: decl ? decl.attributes : [],
      exported,
      ...(modifiers ? { modifiers } : {}),
      inInterface: info.inInterface,
      explicitInterface: decl ? decl.explicitInterface : null,
      csharpKind: info.member,
      sig: decl ? decl.sig : info.sig || null,
      header: decl ? decl.header : info.member === 'top-level' ? '' : p.normaliseHeader(declText),
      throws: decl ? p.thrownOf(declText, decl.headerEnd) : new Set(),
    };
  });
}

/**
 * J-D3's overload pairing for C#: in a file where exactly one member of a name (in one type;
 * `overloadNameOf`: the key up to its parameter list and arity) disappears and exactly one of
 * that name appears, the head member takes the base member's key; its label stays the head's.
 * Pure: returns `head` with paired symbols copied.
 * @template {CollectedSymbol} S
 * @param {S[]} base
 * @param {S[]} head
 * @returns {S[]}
 */
function pairCsharpOverloads(base, head) {
  const baseKeys = new Set(base.map((s) => s.key));
  const headKeys = new Set(head.map((s) => s.key));
  /** @type {Map<string, { gone: S[], fresh: S[] }>} */
  const byName = new Map();
  const group = (/** @type {string} */ name) => {
    let g = byName.get(name);
    if (!g) { g = { gone: [], fresh: [] }; byName.set(name, g); }
    return g;
  };
  for (const b of base) if (!headKeys.has(b.key)) group(overloadNameOf(b.key)).gone.push(b);
  for (const h of head) if (!baseKeys.has(h.key)) group(overloadNameOf(h.key)).fresh.push(h);
  /** @type {Map<S, string>} */
  const renamed = new Map();
  for (const { gone, fresh } of byName.values()) {
    if (gone.length === 1 && fresh.length === 1) renamed.set(fresh[0], gone[0].key);
  }
  if (!renamed.size) return head;
  return head.map((h) => (renamed.has(h) ? { ...h, key: /** @type {string} */ (renamed.get(h)) } : h));
}

/** @param {CollectedSymbol} symbol @returns {string} The parsed signature shown, else the header text. */
const renderCsharpSymbolSig = (symbol) => (symbol.sig
  ? parser().renderCsharpSig(/** @type {any} */ (symbol.sig))
  : /** @type {CsharpCollected} */ (symbol).header);

/**
 * C#'s spec for the shared `prepareFromServerSymbols`.
 * @returns {import('../server-symbols').ServerSymbolSpec}
 */
function csharpSpec() {
  return {
    rules: csharpRules,
    serverName: 'the C# text scan',
    installHint: 'C# files are read from their text',
    collect: (symbols, text) => collectCsharpSymbols(/** @type {CsharpSymbol[]} */ (symbols), text),
    renderSig: renderCsharpSymbolSig,
    kindsOf: (base, head) => parser().csharpKindsOf(/** @type {any} */ (base), /** @type {any} */ (head)),
    pairSymbols: pairCsharpOverloads,
    componentOf: csharpProjectOf,
  };
}

/** Why C# callers are not listed until C5/C8a; starts with "not computed" (resolver-not-computed.js). */
const CALLERS_REASON = 'not computed: C# callers are not searched yet; the changed members and their signature kinds are listed';

/**
 * The changed, added and deleted C# members and their signature kinds from the text alone
 * (`csharpOutline`, then `collectCsharpSymbols`, the header parser, the overload pairing and
 * the shared matching), in units of `csharpProjectOf` (or `ctx.unit`, the preview's), callers
 * not computed. A file the outline cannot read (null: unbalanced `#if` branches, an
 * unterminated literal, a member it cannot parse) is reported by the shared pipeline as not
 * analysed, never as a file without members. `ctx.hooks` is not read.
 * @param {import('../types').PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
async function prepareSyntactic(ctx) {
  const { createNotComputedResolver } = require('../../engine/resolver-not-computed');
  const { csharpOutline } = require('./outline');
  /** @type {import('../types').LanguageServices} */
  const services = /** @type {any} */ ({
    available: async () => ({ ok: true }),
    documentSymbols: async (/** @type {import('../types').DocRef} */ doc) => csharpOutline(/** @type {string} */ (doc.text), { fileName: path.basename(doc.file) }),
  });
  const answer = await require('../server-symbols').prepareFromServerSymbols(
    { ...ctx, hooks: { services, makeResolver: () => createNotComputedResolver(CALLERS_REASON) } }, csharpSpec());
  const files = new Set(answer.units.flatMap((u) => [...u.changed, ...u.deleted]).map((c) => /** @type {any} */ (c).relPath)).size;
  if (files) ctx.warnings.push(`${files} changed C# file(s) read from their text: changed members and signature kinds only; callers ${CALLERS_REASON}`);
  return answer;
}

/** @type {import('../types').LanguageProvider} */
const csharpProvider = Object.freeze({
  ...csharpRules,
  // The outline serves every environment until the editor's callers (C5).
  needsServer: false,
  prepare: prepareSyntactic,
  prepareSyntactic,
});

module.exports = { csharpProvider, csharpSpec, collectCsharpSymbols, pairCsharpOverloads, renderCsharpSymbolSig, prepareSyntactic, CALLERS_REASON };
