// @ts-check
'use strict';
// Go as a language provider (src/languages/types.js; docs/MULTI_LANGUAGE_PLAN.md, G2). Go
// needs a language server: its symbols come from the editor's (gopls through the Go
// extension) via the shared `prepareFromServerSymbols` (../server-symbols.js), and its
// callers from the editor's resolver, which answers Go targets with `callersFromHierarchy`
// and Go's caller extras (`editorCallers`, ./editor-extras.js). What is Go's own here:
// which server symbols are changed-symbol candidates and how they are keyed
// (`collectGoSymbols`), how a header is compared (`goKindsOf`) and shown, which module a
// file belongs to (`goModuleOf`), and how gopls' callers are read (`editorCallers`).
// Without a server (the CLI, the no-checkout preview; S3): `prepareSyntactic`, the same
// candidates from a text outline (`goOutline`, ./outline.js), callers not computed.
//
// Engine modules and the signature parser are required where they are used: the registry
// (../index.js) loads this file, and src/engine/diff.js loads the registry.

const fs = require('fs');
const path = require('path');
const { goRules } = require('./rules');
const { lineStartsOf, lineOf } = require('../text');

/** @typedef {import('../types').ServerSymbol} ServerSymbol */
/** @typedef {import('../types').CollectedSymbol} CollectedSymbol */

/**
 * A Go function or method as a changed-symbol candidate: a `CollectedSymbol` with the
 * declaration's header text, which `goKindsOf` compares when the header parser could not
 * read a side (`sig` null) and `renderGoSymbolSig` shows then.
 * @typedef {CollectedSymbol & { header: string, className: string|null, nested: false,
 *   valueLike: false, decorators: string[], classNamePos: null }} GoSymbol
 */

/**
 * The Go header parser (./signature.js, G3): `parseGoDeclaration(declText)` reads the text
 * from `func` to the closing `}` and returns `{ sig, headerEnd }` (`headerEnd` the offset
 * of the body's `{`), or null for text it cannot read; `renderGoSig(sig)` shows a `sig`.
 * @typedef {{ parseGoDeclaration: (declText: string) => { sig: NonNullable<CollectedSymbol['sig']>, headerEnd: number }|null,
 *   renderGoSig: (sig: NonNullable<CollectedSymbol['sig']>) => string }} GoSignatureParser
 */

/** @returns {GoSignatureParser} */
// Cast: its `GoSig` (`async: false`, `optional: false`) is narrower than the shared `sig`.
const defaultParser = () => /** @type {GoSignatureParser} */ (/** @type {unknown} */ (require('./signature')));

// LSP SymbolKind numbers of what Go's changed symbols are made of. gopls lists functions
// and methods at the top level (G0: methods are not children of their type, and function
// literals are not listed at all: a literal is part of its parent's body).
const SYMBOL_KIND_METHOD = 6;
const SYMBOL_KIND_FUNCTION = 12;
// The start of a function or method declaration's range: `func` then a space or `(`.
const FUNC_DECLARATION = /^func[\s(]/;

/**
 * The receiver's base type of a method name as gopls gives it: `(*AuthConfig).reload` and
 * `(AuthConfig).reload` give `AuthConfig`, `(*List[T]).Push` gives `List`. Null for a
 * plain function.
 * @param {string} name
 * @returns {string|null}
 */
function receiverTypeOf(name) {
  const m = /^\(\*?\s*([^)[\s]+)/.exec(name);
  return name.startsWith('(') && m ? m[1] : null;
}

/** @param {string} name @returns {string} The name after the receiver: `reload` for `(*T).reload`. */
const bareNameOf = (name) => (name.startsWith('(') ? name.slice(name.lastIndexOf(').') + 2) : name);


/** @param {string} header @returns {string} The header with runs of white space as one space. */
const normalizedHeader = (header) => header.replace(/\s+/g, ' ').trim();

/**
 * The changed-symbol candidates of one side of a Go file: its top-level functions and
 * methods as gopls lists them.
 * - `label` is gopls' name (`(*AuthConfig).reload`, `flockRefreshLock`); `simpleName` the
 *   bare name; `className` the receiver's base type for a method.
 * - `key` is the name with the receiver's base type only (`(AuthConfig).reload`), so a
 *   method whose receiver changes between `T` and `*T` (or renames a type parameter) is
 *   the same symbol with a changed signature (the parser lists the receiver as a
 *   parameter), not one deleted and one added. Go allows a method name once per base type,
 *   so the key is unique, except `init`, which a file may declare several times: repeats
 *   are keyed `init#2`, `init#3` in source order.
 * - `namePos` is the name (`selectionRange.start`); `start`/`end` the declaration from
 *   `func` to `}` (`range`; the doc comment is outside it).
 * - `sig` is the header parsed by `parser`, or null when it cannot be read; `header` is the
 *   header text either way (to the body's `{`, or the whole declaration when unparsed).
 * Pure: reads only `symbols` and `text`.
 * @param {ServerSymbol[]} symbols The server's answer for `text`, offsets into it.
 * @param {string} text
 * @param {GoSignatureParser} [parser] The header parser; ./signature.js by default (tests
 *   may pass a stub).
 * @returns {GoSymbol[]}
 */
function collectGoSymbols(symbols, text, parser = defaultParser()) {
  const starts = lineStartsOf(text);
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {GoSymbol[]} */
  const out = [];
  for (const s of symbols) {
    if (s.kind !== SYMBOL_KIND_FUNCTION && s.kind !== SYMBOL_KIND_METHOD) continue;
    const { start, end } = s.range;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= text.length)) {
      throw new RangeError(`Go symbol ${s.name}: range ${start}..${end} is outside its text (length ${text.length})`);
    }
    // gopls gives a type whose underlying type is a function (`type RequestOption
    // func(*requestConfig)`) the Function kind too, with its range at the type's name (G7).
    // Only a `func` declaration is a function or method.
    if (!FUNC_DECLARATION.test(text.slice(start, start + 5))) continue;
    const simpleName = bareNameOf(s.name);
    const receiver = receiverTypeOf(s.name);
    const baseKey = receiver ? `(${receiver}).${simpleName}` : s.name;
    const n = (seen.get(baseKey) || 0) + 1;
    seen.set(baseKey, n);
    const declText = text.slice(start, end);
    const parsed = parser.parseGoDeclaration(declText);
    const bodyBrace = declText.indexOf('{');
    const header = parsed ? declText.slice(0, parsed.headerEnd) : declText.slice(0, bodyBrace < 0 ? declText.length : bodyBrace);
    const startLine = lineOf(starts, start);
    const endLine = lineOf(starts, end);
    out.push({
      label: s.name,
      key: n === 1 ? baseKey : `${baseKey}#${n}`,
      simpleName,
      className: receiver,
      nested: false,
      isConstructor: false,
      classNamePos: null,
      valueLike: false,
      namePos: s.selectionRange.start,
      startLine, endLine, span: endLine - startLine,
      start, end,
      decorators: [],
      exported: /^\p{Lu}/u.test(simpleName),
      sig: parsed ? parsed.sig : null,
      header: normalizedHeader(header),
      throws: new Set(),
    });
  }
  return out;
}

/**
 * The signature kinds of a Go change: `diffSignature` on the parsed headers. When either
 * side's header could not be parsed, the change is not silently "body only": the
 * normalized header texts are compared, and a difference is reported as `type-changed`,
 * the kind that asks the reviewer to look at the signature without claiming what changed.
 * This is conservative: a header the parser cannot read still marks its callers as
 * possibly affected.
 * @param {GoSymbol|undefined} base
 * @param {GoSymbol} head
 * @returns {object[]}
 */
function goKindsOf(base, head) {
  const { diffSignature, KIND } = require('../../engine/signature');
  if (!base) return [];
  if (base.sig && head.sig) return diffSignature(withAnyForEmptyInterface(base), withAnyForEmptyInterface(head));
  return anyForEmptyInterface(base.header) === anyForEmptyInterface(head.header) ? [] : [KIND.TYPE_CHANGED];
}

/**
 * Type text with every empty interface written `any`. Go declares `any` as an alias of
 * `interface{}` (identical types), so `go fix`'s rewrite of one into the other changes no
 * caller (G7: 142 headers in cli/cli PR #14278, each read as a type change before). A
 * package that declares its own `any` is not told apart: its change would read as none.
 * @param {string} text
 */
const anyForEmptyInterface = (text) => text.replace(/\binterface\s*\{\s*\}/g, 'any');

/**
 * A copy of `symbol` whose signature's types read `any` for `interface{}`, for comparing only.
 * @param {GoSymbol} symbol
 * @returns {GoSymbol}
 */
function withAnyForEmptyInterface(symbol) {
  const sig = /** @type {NonNullable<CollectedSymbol['sig']>} */ (symbol.sig);
  return {
    ...symbol,
    sig: {
      ...sig,
      params: sig.params.map((p) => ({ ...p, type: typeof p.type === 'string' ? anyForEmptyInterface(p.type) : p.type })),
      returns: typeof sig.returns === 'string' ? anyForEmptyInterface(sig.returns) : sig.returns,
    },
  };
}

/**
 * @param {GoSignatureParser} [parser]
 * @returns {(symbol: CollectedSymbol) => string} The parsed signature as `renderGoSig`
 *   shows it, or the raw header text when it was not parsed.
 */
const renderGoSymbolSig = (parser = defaultParser()) => (symbol) => (symbol.sig
  ? parser.renderGoSig(symbol.sig)
  : /** @type {GoSymbol} */ (symbol).header);

/**
 * The Go module a file belongs to: the directory of the nearest `go.mod` above it, within
 * the repository. Shown as the unit's name: `(root)` for the repository root, the
 * repository-relative directory otherwise, `(no go.mod)` when none is found (a file outside
 * every module still has its symbols listed; gopls answers it as an ad-hoc package).
 * Reads the file system: one `existsSync` per directory level of the path.
 * @param {string} relPath Repository-relative.
 * @param {string} repo Absolute repository root.
 * @returns {{ component: string, projectRoot: string }}
 */
function goModuleOf(relPath, repo) {
  let dir = path.posix.dirname(relPath.split(path.sep).join('/'));
  for (;;) {
    const probe = dir === '.' ? repo : path.join(repo, dir);
    if (fs.existsSync(path.join(probe, 'go.mod'))) {
      return dir === '.' ? { component: '(root)', projectRoot: '' } : { component: dir, projectRoot: dir };
    }
    if (dir === '.' || dir === '/' || dir === '') return { component: '(no go.mod)', projectRoot: '' };
    dir = path.posix.dirname(dir);
  }
}

/**
 * Go's spec for the shared `prepare`.
 * @param {GoSignatureParser} [parser] The header parser; ./signature.js by default.
 * @returns {import('../server-symbols').ServerSymbolSpec}
 */
function goSpec(parser) {
  const p = parser || defaultParser();
  return {
    rules: goRules,
    serverName: 'the Go language server',
    installHint: 'Install the Go extension to analyse Go files',
    collect: (symbols, text) => collectGoSymbols(symbols, text, p),
    renderSig: renderGoSymbolSig(p),
    kindsOf: /** @type {any} */ (goKindsOf),
    componentOf: goModuleOf,
    declaresSymbols: (text) => /^func[\s(]/m.test(text),
  };
}

/**
 * Finds the changed Go functions and methods; see `prepareFromServerSymbols` for what it
 * reads from `ctx.hooks` (the environment's `services` and `makeResolver`, both required).
 * @param {import('../types').PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
const prepare = (ctx) => require('../server-symbols').prepareFromServerSymbols(ctx, goSpec());

/**
 * `prepare` where there is no language server (the CLI, the no-checkout preview; S3): the
 * changed, added and deleted functions and methods and their signature kinds from the text
 * alone (`goOutline`, shaped as gopls' answer, then the same `collectGoSymbols`, header
 * parser and matching as `prepare`, so keys and review ids are the editor's), with callers
 * not computed: every unit's resolver is `createNotComputedResolver`'s. Units are
 * `ctx.unit` when given (the preview's "pull request": nothing is read from disk, the texts
 * are `ctx.headTexts`/`ctx.baseTexts`), else Go modules by `go.mod` (`goModuleOf`, the CLI).
 * A file excluded by build constraints is read as any other: its functions are its own
 * (keyed by file, as gopls keys them). `ctx.hooks` is not read. One warning says the callers
 * were not computed, for how many files.
 * @param {import('../types').PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
async function prepareSyntactic(ctx) {
  const { createNotComputedResolver, notComputedReason } = require('../../engine/resolver-not-computed');
  const { goOutline } = require('./outline');
  const reason = notComputedReason(goRules.displayName);
  const spec = {
    ...goSpec(),
    serverName: 'the Go text scan',
    // The outline is the whole answer: an empty one is a file with no functions.
    declaresSymbols: undefined,
  };
  /** @type {import('../types').LanguageServices} */
  const services = /** @type {any} */ ({
    available: async () => ({ ok: true }),
    documentSymbols: async (/** @type {import('../types').DocRef} */ doc) => goOutline(/** @type {string} */ (doc.text)),
  });
  const answer = await require('../server-symbols').prepareFromServerSymbols(
    { ...ctx, hooks: { services, makeResolver: () => createNotComputedResolver(reason) } }, spec);
  const files = answer.units.reduce((n, u) => n + new Set([...u.changed, ...u.deleted].map((/** @type {any} */ c) => c.relPath)).size, 0);
  if (files) ctx.warnings.push(`${files} changed Go file(s) read from their text: changed functions and signature kinds only; callers ${reason}`);
  return answer;
}

/**
 * Go's caller extras for the editor's resolver (./editor-extras.js): value uses are not
 * calls, a file outside the active build says so, and a method that shares an interface
 * with code outside the repository may be missing callers. Required here, not at the top,
 * for the same reason as the engine modules above.
 * @type {NonNullable<import('../types').LanguageProvider['editorCallers']>}
 */
const editorCallers = ({ trace, services, repoRoot }) => require('./editor-extras').createGoEditorExtras({ trace, services, repoRoot });

/**
 * Where the editor's Go server is warmed (src/readiness.js): the name of the first
 * function or method gopls lists in the first changed Go file. Only that file is asked:
 * each answer from a server that is still loading can take seconds, and any file of the
 * module makes gopls load the module. Null when the editor has no Go support (logged; the
 * analysis itself reports it, once, as "Install the Go extension to analyse Go files"),
 * when the server gives no symbols, or when the file declares no function.
 * Rejects when the server's request fails; readiness logs that and analyses unwarmed.
 * @type {NonNullable<import('../types').LanguageProvider['warmUpTarget']>}
 */
async function warmUpTarget({ repo, files, services, log }) {
  if (!services) return null;
  const availability = await services.available(goRules.id);
  if (!availability.ok) {
    log(`warm-up: Go skipped — ${availability.reason}`);
    return null;
  }
  const file = path.join(repo, files[0]);
  const symbols = await services.documentSymbols({ file, side: 'head' });
  const first = (symbols || []).find((s) => s.kind === SYMBOL_KIND_FUNCTION || s.kind === SYMBOL_KIND_METHOD);
  return first ? { file, pos: first.selectionRange.start } : null;
}

/** @type {import('../types').LanguageProvider} */
const goProvider = Object.freeze({
  ...goRules,
  needsServer: true,
  prepare,
  prepareSyntactic,
  editorCallers,
  warmUpTarget,
  serverLabel: 'the Go language server (gopls)',
});

module.exports = { goProvider, goSpec, collectGoSymbols, goKindsOf, goModuleOf, renderGoSymbolSig, prepareSyntactic };
