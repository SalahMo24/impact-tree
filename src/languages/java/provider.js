// @ts-check
'use strict';
// Java as a language provider (src/languages/types.js; docs/MULTI_LANGUAGE_PLAN.md, J2).
// Java needs a language server: its symbols come from the editor's (Eclipse JDT LS, "jdtls",
// through Red Hat's Java extension) via the shared `prepareFromServerSymbols`
// (../server-symbols.js). What is Java's own here: which server symbols are changed-symbol
// candidates and how they are keyed (`collectJavaSymbols`, keys from ./keys.js), how an
// overload whose parameter list changed is paired with its old self (`pairOverloads`), and
// which project a file belongs to (`javaProjectOf`, ./rules.js). The header parser and the
// signature kinds are ./signature.js's (J3); how jdtls' callers are read is
// ./editor-extras.js's (J4).
// Without a server (the CLI, the no-checkout preview; J7): `prepareSyntactic`, the same
// candidates from a text outline (`javaOutline`, ./outline.js), callers not computed.
//
// Engine modules and the signature parser are required where they are used: the registry
// (../index.js) loads this file, and src/engine/diff.js loads the registry.

const { javaRules, javaProjectOf } = require('./rules');
const { memberNameOf, typeSegmentOf, javaKeyOf } = require('./keys');
const { lineStartsOf, lineOf } = require('../text');

/** @typedef {import('../types').ServerSymbol} ServerSymbol */
/** @typedef {import('../types').CollectedSymbol} CollectedSymbol */

/**
 * A Java method or constructor as a changed-symbol candidate: a `CollectedSymbol` with the
 * declaration's header text, which `javaKindsOf` compares when the header parser could not
 * read a side (`sig` null) and `renderJavaSymbolSig` shows then. `decorators` are the
 * annotations the parser read.
 * `modifiers` are the parser's, absent when it could not read the header (never [], which
 * would read as every modifier removed: J3's `javaKindsOf` compares access only when both
 * sides have them); `inInterface` is
 * true for a method declared directly in an interface or annotation type, whose members
 * are public without the modifier (`javaKindsOf` reads it so).
 * @typedef {CollectedSymbol & { header: string, className: string|null, nested: false,
 *   valueLike: false, decorators: string[], classNamePos: null, modifiers?: string[],
 *   inInterface: boolean }} JavaSymbol
 */

/**
 * The Java header parser (./signature.js, J3):
 * - `parseJavaDeclaration(declText)`: `declText` is jdtls' range text (it may start with
 *   Javadoc, comments and annotations, and ends at the body's `}` or at `;`); null for text
 *   it cannot read. `headerEnd` is the offset of the body's `{` or the `;`.
 * - `thrownOf(declText, headerEnd)`: the exceptions the method declares or throws.
 * - `javaKindsOf(base, head)`: the signature kinds of a change.
 * - `renderJavaSig(sig)`: a `sig` as shown.
 * @typedef {{
 *   parseJavaDeclaration: (declText: string) => { sig: NonNullable<CollectedSymbol['sig']>, headerEnd: number, modifiers: string[], annotations: string[], typeParameters: string }|null,
 *   thrownOf: (declText: string, headerEnd: number) => Set<string>,
 *   javaKindsOf: (base: any, head: any) => object[],
 *   renderJavaSig: (sig: NonNullable<CollectedSymbol['sig']>) => string }} JavaSignatureParser
 */

/** @returns {JavaSignatureParser} */
const defaultParser = () => /** @type {JavaSignatureParser} */ (/** @type {unknown} */ (require('./signature')));

// LSP SymbolKind numbers jdtls gives (J0).
const KIND = Object.freeze({
  CLASS: 5, METHOD: 6, PROPERTY: 7, FIELD: 8, CONSTRUCTOR: 9, ENUM: 10, INTERFACE: 11,
  CONSTANT: 14, ENUM_MEMBER: 22, STRUCT: 23,
});
/** @type {ReadonlySet<number>} */
const TYPE_KINDS = new Set([KIND.CLASS, KIND.ENUM, KIND.INTERFACE, KIND.STRUCT]);
// A member whose initializer can hold an anonymous class body (`static final TypeAdapter<X>
// X = new TypeAdapter<X>() { … }`) or that has a body of its own (an enum constant's `{…}`).
/** @type {ReadonlySet<number>} */
const MEMBER_KINDS = new Set([KIND.FIELD, KIND.CONSTANT, KIND.ENUM_MEMBER, KIND.PROPERTY]);
// jdtls' names for a type with no name (J0): an anonymous class `new TypeAdapter() {...}`,
// an enum constant's body `{...}`.
const ANONYMOUS_BODY = /^(new\s.*\{\.\.\.\}|\{\.\.\.\})$/;

/**
 * Where a declaration starts once its leading Javadoc, block and line comments are skipped:
 * at its first annotation or modifier. jdtls' range starts at the Javadoc (J0); the shared
 * engine reads a doc comment as outside the symbol (Go's and TypeScript's ranges exclude
 * it), so a Javadoc-only edit is an outside range, not a changed method.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function declarationStartOf(text, start, end) {
  let i = start;
  for (;;) {
    while (i < end && /\s/.test(text[i])) i++;
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close + 2 > end) return start;
      i = close + 2;
    } else if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      if (nl < 0 || nl >= end) return start;
      i = nl + 1;
    } else {
      return i < end ? i : start;
    }
  }
}

/**
 * The header's text when the parser could not read it: from the declaration's start to the
 * first `{` or `;` outside parentheses (an annotation's `{"a", "b"}` argument is inside
 * its parentheses).
 * @param {string} declText
 * @returns {string}
 */
function headerTextOf(declText) {
  let depth = 0;
  for (let i = 0; i < declText.length; i++) {
    const ch = declText[i];
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if ((ch === '{' || ch === ';') && depth === 0) return declText.slice(0, i);
  }
  return declText;
}

/** @param {string} header @returns {string} The header with runs of white space as one space. */
const normalizedHeader = (header) => header.replace(/\s+/g, ' ').trim();

/**
 * The changed-symbol candidates of one side of a Java file: the methods and constructors of
 * every class, interface, enum and record, nested types included, as jdtls lists them.
 * - Not candidates: anything inside a method or constructor (its anonymous and local
 *   classes; lambdas are never listed): they are part of that method's body (P-D5).
 * - An enum constant's body and an anonymous class in a field's initializer are keyed by the
 *   constant or field: `FieldNamingPolicy.IDENTITY.translateName(Field)`,
 *   `TypeAdapters.URL.read(JsonReader)`; they are no method's body.
 * - `key` is `Outer.Inner.method(T1, T2)` (./keys.js), constructors `Outer.<init>(T1)`;
 *   a true repeat of a key (only broken code has one) is `#2`, `#3` in source order.
 *   `label` is the key without the repeat number, a constructor shown `new Outer(T1)`.
 * - `namePos` is the name (`selectionRange.start`: J0, a constructor's callers are asked
 *   at its own name, not the class's). `start`/`startLine` skip the leading Javadoc and
 *   comments (`declarationStartOf`) and keep the annotations, as Python keeps decorators;
 *   `end` is the body's `}`.
 * - `sig`, `throws` and `decorators` come from `parser` on jdtls' whole range text; `header`
 *   is the header text from the first annotation or modifier to the body, normalised.
 * - `exported`: `public` or `protected`, or any member of an interface (implicitly public).
 * Pure: reads only `symbols` and `text`. Throws RangeError for a range outside `text`.
 * @param {ServerSymbol[]} symbols The server's answer for `text`, offsets into it.
 * @param {string} text
 * @param {JavaSignatureParser} [parser] The header parser; ./signature.js by default (tests
 *   may pass a stub).
 * @returns {JavaSymbol[]}
 */
function collectJavaSymbols(symbols, text, parser = defaultParser()) {
  const starts = lineStartsOf(text);
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {JavaSymbol[]} */
  const out = [];

  /**
   * @param {ServerSymbol} s
   * @param {string[]} path
   * @param {string|null} className
   * @param {boolean} inInterface
   */
  function addCallable(s, path, className, inInterface) {
    const { start, end } = s.range;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= text.length)) {
      throw new RangeError(`Java symbol ${s.name}: range ${start}..${end} is outside its text (length ${text.length})`);
    }
    const member = memberNameOf(s.name);
    // A Method without a parameter list is no method jdtls names (J0: a release-8 module
    // lists a nested record as a Method `R(String, String)`, still with one); skip it.
    if (!member) return;
    const isConstructor = s.kind === KIND.CONSTRUCTOR;
    const baseKey = javaKeyOf(path, member.simpleName, member.params, isConstructor);
    const n = (seen.get(baseKey) || 0) + 1;
    seen.set(baseKey, n);
    const declText = text.slice(start, end);
    const parsed = parser.parseJavaDeclaration(declText);
    const declStart = declarationStartOf(text, start, end);
    const header = parsed
      ? declText.slice(declStart - start, Math.max(declStart - start, parsed.headerEnd))
      : headerTextOf(text.slice(declStart, end));
    const words = parsed ? parsed.modifiers : header.replace(/@[\w$.]+\s*(\([^)]*\))?/g, ' ').split(/[\s(<]+/);
    const startLine = lineOf(starts, declStart);
    const endLine = lineOf(starts, end);
    out.push({
      label: isConstructor ? `new ${baseKey.slice(0, baseKey.indexOf('.<init>('))}${baseKey.slice(baseKey.indexOf('('))}` : baseKey,
      key: n === 1 ? baseKey : `${baseKey}#${n}`,
      simpleName: member.simpleName,
      className,
      nested: false,
      isConstructor,
      classNamePos: null,
      valueLike: false,
      namePos: s.selectionRange.start,
      startLine, endLine, span: endLine - startLine,
      start: declStart, end,
      decorators: parsed ? parsed.annotations : [],
      exported: inInterface || words.includes('public') || words.includes('protected'),
      ...(parsed ? { modifiers: parsed.modifiers } : {}),
      inInterface,
      sig: parsed ? parsed.sig : null,
      header: normalizedHeader(header),
      throws: parsed ? parser.thrownOf(declText, parsed.headerEnd) : new Set(),
    });
  }

  /**
   * The members of a type (or of an enum constant's or anonymous class's body).
   * Recursive over nested types: the depth is the source's type nesting and the total work
   * the server's answer for one file (each symbol visited once); method children are not
   * walked.
   * @param {ServerSymbol[]} members
   * @param {string[]} path
   * @param {string|null} className
   * @param {boolean} inInterface
   */
  function walkMembers(members, path, className, inInterface) {
    for (const s of members) {
      if (s.kind === KIND.METHOD || s.kind === KIND.CONSTRUCTOR) {
        // Its children (anonymous and local classes) are its body.
        addCallable(s, path, className, inInterface);
      } else if (TYPE_KINDS.has(s.kind) && !ANONYMOUS_BODY.test(s.name)) {
        const segment = typeSegmentOf(s.name);
        walkMembers(s.children || [], [...path, segment], segment, s.kind === KIND.INTERFACE);
      } else if (MEMBER_KINDS.has(s.kind)) {
        for (const body of s.children || []) {
          if (TYPE_KINDS.has(body.kind) && ANONYMOUS_BODY.test(body.name)) {
            walkMembers(body.children || [], [...path, s.name], className, false);
          }
        }
      }
    }
  }

  for (const s of symbols) {
    if (TYPE_KINDS.has(s.kind) && !ANONYMOUS_BODY.test(s.name)) {
      const segment = typeSegmentOf(s.name);
      walkMembers(s.children || [], [segment], segment, s.kind === KIND.INTERFACE);
    }
  }
  return out;
}

/**
 * J-D3's overload pairing: in a file where exactly one method of a name (in one type)
 * disappears and exactly one of that name appears, the two are one method whose parameter
 * list changed, not a deletion plus an addition. The head symbol takes the base symbol's
 * key (the row's identity, as a review tick knows it); its label stays the head's. Two out
 * and two in (or one out and two in) are not paired: which became which cannot be told.
 * Constructors pair the same way, by type. Pure: returns `head` with paired symbols copied.
 * @template {CollectedSymbol} S
 * @param {S[]} base
 * @param {S[]} head
 * @returns {S[]}
 */
function pairOverloads(base, head) {
  const baseKeys = new Set(base.map((s) => s.key));
  const headKeys = new Set(head.map((s) => s.key));
  // `Outer.Inner.method`: the key up to its parameter list.
  const nameOf = (/** @type {CollectedSymbol} */ s) => s.key.slice(0, s.key.indexOf('('));
  /** @type {Map<string, { gone: S[], fresh: S[] }>} */
  const byName = new Map();
  const group = (/** @type {string} */ name) => {
    let g = byName.get(name);
    if (!g) { g = { gone: [], fresh: [] }; byName.set(name, g); }
    return g;
  };
  for (const b of base) if (!headKeys.has(b.key)) group(nameOf(b)).gone.push(b);
  for (const h of head) if (!baseKeys.has(h.key)) group(nameOf(h)).fresh.push(h);
  /** @type {Map<S, string>} */
  const renamed = new Map();
  for (const { gone, fresh } of byName.values()) {
    if (gone.length === 1 && fresh.length === 1) renamed.set(fresh[0], gone[0].key);
  }
  if (!renamed.size) return head;
  return head.map((h) => (renamed.has(h) ? { ...h, key: /** @type {string} */ (renamed.get(h)) } : h));
}

/**
 * @param {JavaSignatureParser} [parser]
 * @returns {(symbol: CollectedSymbol) => string} The parsed signature as `renderJavaSig`
 *   shows it, or the raw header text when it was not parsed.
 */
const renderJavaSymbolSig = (parser = defaultParser()) => (symbol) => (symbol.sig
  ? parser.renderJavaSig(symbol.sig)
  : /** @type {JavaSymbol} */ (symbol).header);

/**
 * Java's spec for the shared `prepare`.
 * @param {JavaSignatureParser} [parser] The header parser; ./signature.js by default.
 * @returns {import('../server-symbols').ServerSymbolSpec}
 */
function javaSpec(parser) {
  const p = parser || defaultParser();
  return {
    rules: javaRules,
    serverName: 'the Java language server',
    installHint: 'Install the Extension Pack for Java / Language Support for Java by Red Hat (redhat.java) to analyse Java files',
    collect: (symbols, text) => collectJavaSymbols(symbols, text, p),
    renderSig: renderJavaSymbolSig(p),
    kindsOf: (base, head) => p.javaKindsOf(base, head),
    pairSymbols: pairOverloads,
    componentOf: javaProjectOf,
    // jdtls lists every type of a file it has loaded (J0), so an empty answer for a text
    // that declares one is no answer.
    declaresSymbols: (text) => /(^|[\s;}])(class|interface|enum|record)\s+[\w$]/m.test(text),
  };
}

/**
 * Finds the changed Java methods and constructors; see `prepareFromServerSymbols` for what
 * it reads from `ctx.hooks` (the environment's `services` and `makeResolver`, both required).
 * @param {import('../types').PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
const prepare = (ctx) => require('../server-symbols').prepareFromServerSymbols(ctx, javaSpec());

/**
 * Java's caller extras (./editor-extras.js, J4): method references are value uses, callers
 * in jdtls' default project are dropped, and overrides, overridable methods, constructors,
 * DI factories and annotation-processed types read incomplete with their reason.
 * @type {NonNullable<import('../types').LanguageProvider['editorCallers']>}
 */
const editorCallers = ({ trace, services, repoRoot, clock }) => require('./editor-extras').createJavaEditorExtras({ trace, services, repoRoot, ...(clock ? { clock } : {}) });

/**
 * `prepare` where there is no language server (the CLI, the no-checkout preview; J7): the
 * changed, added and deleted methods and constructors and their signature kinds from the
 * text alone (`javaOutline`, shaped as jdtls' answer, then the same `collectJavaSymbols`,
 * header parser, overload pairing and matching as `prepare`, so keys and review ids are the
 * editor's), with callers not computed: every unit's resolver is
 * `createNotComputedResolver`'s (J8 replaces it with a syntax-only index). Units are
 * `ctx.unit` when given (the preview's "pull request": nothing is read from disk, the texts
 * are `ctx.headTexts`/`ctx.baseTexts`), else projects by `javaProjectOf` (the CLI). A file
 * the outline cannot read (null) is reported by the shared pipeline as unread, never as a
 * file without methods. `ctx.hooks` is not read. One warning says the callers were not
 * computed, for how many files.
 * @param {import('../types').PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
async function prepareSyntactic(ctx) {
  const { createNotComputedResolver, notComputedReason } = require('../../engine/resolver-not-computed');
  const { javaOutline } = require('./outline');
  const reason = notComputedReason(javaRules.displayName);
  const spec = {
    ...javaSpec(),
    serverName: 'the Java text scan',
    // The outline is the whole answer: an empty one is a file with no types.
    declaresSymbols: undefined,
  };
  /** @type {import('../types').LanguageServices} */
  const services = /** @type {any} */ ({
    available: async () => ({ ok: true }),
    documentSymbols: async (/** @type {import('../types').DocRef} */ doc) => javaOutline(/** @type {string} */ (doc.text)),
  });
  const answer = await require('../server-symbols').prepareFromServerSymbols(
    { ...ctx, hooks: { services, makeResolver: () => createNotComputedResolver(reason) } }, spec);
  const files = answer.units.reduce((n, u) => n + new Set([...u.changed, ...u.deleted].map((/** @type {any} */ c) => c.relPath)).size, 0);
  if (files) ctx.warnings.push(`${files} changed Java file(s) read from their text: changed methods and signature kinds only; callers ${reason}`);
  return answer;
}

/**
 * The first method or constructor in `symbols`, in source order. jdtls lists a method as a
 * child of its type (J0), so types are searched, nested ones included; a method's own
 * children (local and anonymous classes) are not, nor are fields.
 * Recursive over nested types: bounded by the source's type nesting and the size of one
 * file's answer.
 * @param {ServerSymbol[]} symbols
 * @returns {ServerSymbol|null}
 */
function firstCallable(symbols) {
  for (const symbol of symbols) {
    if (symbol.kind === KIND.METHOD || symbol.kind === KIND.CONSTRUCTOR) return symbol;
    if (TYPE_KINDS.has(symbol.kind)) {
      const inner = firstCallable(symbol.children || []);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Where the editor's Java server is warmed (src/readiness.js): the first method or
 * constructor jdtls lists in the first changed Java file, as Go's and Python's. Only that
 * file is asked: jdtls imports the whole Maven or Gradle project when it is first asked
 * about any file of it (J0). Null when the editor has no Java support (logged; the analysis
 * itself reports it once), when the server gives no symbols, or when the file declares no
 * method. Rejects when the server's request fails; readiness logs that and analyses unwarmed.
 * @type {NonNullable<import('../types').LanguageProvider['warmUpTarget']>}
 */
async function warmUpTarget({ repo, files, services, log }) {
  if (!services) return null;
  const availability = await services.available(javaRules.id);
  if (!availability.ok) {
    log(`warm-up: Java skipped — ${availability.reason}`);
    return null;
  }
  const file = require('path').join(repo, files[0]);
  const symbols = await services.documentSymbols({ file, side: 'head' });
  const first = firstCallable(symbols || []);
  return first ? { file, pos: first.selectionRange.start } : null;
}

/** @type {import('../types').LanguageProvider} */
const javaProvider = Object.freeze({
  ...javaRules,
  needsServer: true,
  prepare,
  editorCallers,
  prepareSyntactic,
  warmUpTarget,
  serverLabel: 'the Java language server (jdtls)',
});

module.exports = { javaProvider, javaSpec, collectJavaSymbols, pairOverloads, declarationStartOf, renderJavaSymbolSig, prepareSyntactic };
