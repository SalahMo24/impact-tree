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
// Callers come from a syntax-only index (./syntactic-index.js, C8a) until the editor's callers
// (C5): `needsServer` is false and `prepare` and `prepareSyntactic` are the same path, so the
// editor, the CLI and the no-checkout preview list the same changed members, kinds and callers.
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

/** What the syntax index does not resolve, for the preview's `callersScope` (types.js, PreparedLanguage). */
const UNRESOLVED = 'calls through an interface or an override, extension methods, method groups, reflection, generated members, and receivers whose type is not written';

/**
 * The changed, added and deleted C# members and their signature kinds from the text alone
 * (`csharpOutline`, then `collectCsharpSymbols`, the header parser, the overload pairing and
 * the shared matching), in units of `csharpProjectOf` (or `ctx.unit`, the preview's), with
 * callers from a syntax-only index (./syntactic-index.js, C8a) shared by every unit. The index
 * reads `ctx.syntacticSources` when given (the preview: the PR's C# files, implicit usings
 * assumed from the web SDK, no answer complete), else the repository per C-D8
 * (`indexRepository`). A file the outline cannot read (null) is reported by the shared
 * pipeline as not analysed, never as a file without members. `ctx.hooks` is not read.
 * @param {import('../types').PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
async function prepareSyntactic(ctx) {
  const { createSyntacticResolver } = require('../../engine/resolver-syntactic');
  const { csharpOutline } = require('./outline');
  /** @type {import('../types').LanguageServices} */
  const services = /** @type {any} */ ({
    available: async () => ({ ok: true }),
    documentSymbols: async (/** @type {import('../types').DocRef} */ doc) => csharpOutline(/** @type {string} */ (doc.text), { fileName: path.basename(doc.file) }),
  });
  // A stand-in until the units are known: the index is built once, for all of them, below.
  const pending = Object.freeze({ pending: true });
  const answer = await require('../server-symbols').prepareFromServerSymbols(
    { ...ctx, hooks: { services, makeResolver: () => /** @type {any} */ (pending) } }, csharpSpec());
  if (!answer.units.length) return answer;
  /** @type {any[]} */
  const changed = answer.units.flatMap((u) => [...u.changed, ...u.deleted]);
  const { createCsharpSyntacticIndex, WEB_IMPLICIT_USINGS } = require('./syntactic-index');
  const idx = ctx.syntacticSources
    ? createCsharpSyntacticIndex(ctx.syntacticSources.filter((s) => csharpRules.handles(s.path)), {
      root: ctx.repo, scope: `the pull request's own files (${ctx.syntacticSources.length} C# file(s) indexed)`, partial: true, implicitUsings: WEB_IMPLICIT_USINGS,
    })
    : indexRepository(ctx, changed);
  const { isTestFile } = require('../../engine/diff');
  const resolver = {
    ...createSyntacticResolver(idx, /** @type {any} */ ({ isTestPath: (/** @type {string} */ file) => isTestFile(ctx.repo, file) })),
    // The syntax-only answers are lower bounds, so a blast radius counted from them is one too.
    callersLowerBound: true,
  };
  for (const unit of answer.units) unit.resolver = /** @type {any} */ (resolver);
  const files = new Set(changed.map((c) => c.relPath)).size;
  if (files) ctx.warnings.push(`${files} changed C# file(s) read from their text: changed members and signature kinds; ${idx.scopeNote()}`);
  return { ...answer, extras: { ...answer.extras, scopeNote: idx.scopeNote(), unresolved: UNRESOLVED } };
}

// Directories whose C# files are build output (C-D8), at any depth.
const NOT_SOURCE_DIRS = new Set(['bin', 'obj', 'node_modules']);
const UI_FILE = /\.(razor|cshtml|xaml|axaml)$/i;

/**
 * The CLI's C# index (C-D8 (a)): every C# file of the repository the C# rules handle, from the
 * tracked and untracked files, read from disk, bounded by `REPO_MAX_FILES`/`REPO_MAX_BYTES`
 * (../repository-files.js): past the bound, the changed projects' files plus the files that
 * mention a changed name. Implicit usings from the `.csproj` files (`projectFacts`); projects
 * with Razor/XAML files are passed as `uiDirs`. When the files cannot be listed, the changed
 * files only, and the scope says so. Reads the file system and the repository.
 * @param {import('../types').PrepareContext} ctx
 * @param {any[]} changed The changed and deleted symbols.
 */
function indexRepository(ctx, changed) {
  const fs = require('fs');
  const { createCsharpSyntacticIndex, MAX_FILE_BYTES } = require('./syntactic-index');
  const { pickRepositoryFiles, REPO_MAX_FILES, REPO_MAX_BYTES } = require('../repository-files');
  const read = (/** @type {string} */ rel) => { try { return fs.readFileSync(path.join(ctx.repo, rel), 'utf8'); } catch { return null; } };
  const changedPaths = new Set(ctx.files.map((f) => f.path).filter((p) => csharpRules.handles(p)));
  const out = ctx.git && ctx.git.tryRaw(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (out == null) {
    const sources = /** @type {Array<{ path: string, text: string }>} */ ([...changedPaths].map((rel) => ({ path: rel, text: read(rel) })).filter((s) => s.text != null));
    return createCsharpSyntacticIndex(sources, { root: ctx.repo, scope: `the changed files only (the repository's files could not be listed; ${sources.length} C# file(s) indexed)`, partial: true });
  }
  const all = [...new Set(String(out).split('\0').filter(Boolean))];
  const projects = all.filter((rel) => /\.csproj$/i.test(rel));
  const { usings, uiDirs } = projectFacts(projects, all, read);
  const listed = all
    .filter((rel) => csharpRules.handles(rel) && !path.posix.dirname(rel).split('/').some((d) => NOT_SOURCE_DIRS.has(d)))
    .flatMap((rel) => { try { return [{ path: rel, size: fs.statSync(path.join(ctx.repo, rel)).size }]; } catch { return []; } });
  const names = new Set(changed.map((c) => c.simpleName));
  const changedDirs = [...changedPaths].map((rel) => csharpProjectDir(rel, projects));
  const picked = pickRepositoryFiles(listed, read, {
    changedPaths, names, keep: (rel) => changedPaths.has(rel) || changedDirs.some((d) => d === '' || rel.startsWith(`${d}/`)), maxFileBytes: MAX_FILE_BYTES,
  });
  const scope = picked.bounded
    ? `the repository's changed projects and the files that mention a changed name (${picked.sources.length} of ${listed.length} C# file(s) indexed: over the bound of ${REPO_MAX_FILES} files or ${REPO_MAX_BYTES / 1024 / 1024} MiB)`
    : `the repository (${picked.sources.length} C# file(s) indexed)`;
  return createCsharpSyntacticIndex(picked.sources, { root: ctx.repo, scope, notIndexed: picked.notIndexed, partial: picked.bounded, implicitUsings: usings, uiDirs });
}

/**
 * The directory of the nearest `.csproj` above `rel` among `projects` ('' at the root), else
 * `rel`'s own directory. Pure.
 * @param {string} rel @param {string[]} projects
 */
function csharpProjectDir(rel, projects) {
  /** @type {string|null} */
  let best = null;
  for (const p of projects) {
    const d = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p);
    if ((d === '' || rel.startsWith(`${d}/`)) && (best === null || d.length > best.length)) best = d;
  }
  return best === null ? path.posix.dirname(rel) : best;
}

/**
 * The implicit usings (the union over the projects that enable them, applied to every file:
 * a listed approximation) and the project directories with Razor/XAML files.
 * @param {string[]} projects @param {string[]} all @param {(rel: string) => string|null} read
 */
function projectFacts(projects, all, read) {
  const { implicitUsingsOf } = require('./syntactic-index');
  /** @type {Set<string>} */
  const usings = new Set();
  for (const p of projects) for (const u of implicitUsingsOf(read(p) || '')) usings.add(u);
  /** @type {Set<string>} */
  const uiDirs = new Set();
  for (const rel of all) if (UI_FILE.test(rel)) uiDirs.add(csharpProjectDir(rel, projects));
  return { usings: [...usings], uiDirs: [...uiDirs] };
}

/** @type {import('../types').LanguageProvider} */
const csharpProvider = Object.freeze({
  ...csharpRules,
  // The outline and the syntax index serve every environment until the editor's callers (C5).
  needsServer: false,
  prepare: prepareSyntactic,
  prepareSyntactic,
});

module.exports = { csharpProvider, csharpSpec, collectCsharpSymbols, pairCsharpOverloads, renderCsharpSymbolSig, prepareSyntactic, projectFacts, csharpProjectDir, NOT_SOURCE_DIRS };
