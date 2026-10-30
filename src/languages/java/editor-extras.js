// @ts-check
'use strict';
// What a caller resolver adds for a Java target to the callers jdtls reports
// (docs/MULTI_LANGUAGE_PLAN.md, J4; `EditorCallerExtras` in ../types.js). Applied by the
// editor's resolver (src/session/resolver-vscode.js) and, the same way, by the jdtls harness
// (test/lsp-harness/java-e2e.js through harness-languages.js).
//
// - Value uses are not calls. jdtls lists a method reference (`parser::next`, `Foo::new`)
//   as an incoming call (J0 §3). `filter` reads the text before each site: a site right
//   after `::` is a value use. As Go's (G4): a caller whose every readable site is a value
//   use is dropped, a caller with both keeps its other sites, and a value use makes the
//   answer incomplete with `referenced-as-value` (its calls through the functional
//   interface cannot be followed).
// - Locations that are not the workspace's. jdtls keeps the editor's base-side temporary
//   copy in its default project (`jdt.ls-java-project`) and can list it as a caller after the
//   copy is deleted (J2's end-to-end runs). Such a caller, and any caller outside the
//   repository, is dropped and traced. Not incomplete: the copy is the base side of a
//   workspace file, whose head side jdtls lists itself, and a caller outside the repository
//   is no row of the review.
// - Overrides. incomingCalls on a method that overrides or implements another lists the
//   callers of the method it overrides (J0 §3: `JsonStreamParser.next` gets unrelated
//   `Iterator.next()` calls), so its list is a superset and a listed call may run another
//   implementation: incomplete (OVERRIDES_REASON). Read from the text: `@Override`, the
//   `Object` methods (`equals(x)`, `hashCode()`, `toString()`, `clone()`, `finalize()`),
//   and any non-static, non-private method of an anonymous class or an enum constant's body
//   (which can only be reached through its supertype). Missed: an override in a named class
//   written without `@Override` (jdtls' supertypes are not asked: the services have no type
//   hierarchy).
// - Overridable and overridden. A method that can be overridden (not a constructor, not
//   static, private or final, in a type that is not final or a record) is asked for its
//   implementations (`services.implementations`, one query, IMPLEMENTATIONS_TIMEOUT_MS):
//   one elsewhere in the workspace makes the answer incomplete (OVERRIDDEN_REASON), as a
//   listed call may run it. A query that fails, times out or gives no answer makes it
//   incomplete with that reason, never "not overridden".
// - Constructors. jdtls lists `new T(…)`, `this(…)` and `super(…)` at the constructor's
//   name (J0). A subclass constructor's implicit `super()` is not a call site it lists, so a
//   no-argument constructor of a class that is not final is incomplete (IMPLICIT_SUPER_REASON).
//   A constructor of a dependency-injection class (DI_CLASS_ANNOTATIONS on the class, or
//   `@Inject`/`@Autowired` on the constructor) with no caller reads `'di'` as TypeScript's
//   does (the shared `callersFromHierarchy`); any other constructor with no caller is
//   incomplete (UNBUILT_REASON), not `'di'`. A `@Bean`/`@Provides`/`@Produces` method is
//   called by the container: incomplete (DI_FACTORY_REASON).
// - Annotation processing. A target in a type annotated for Lombok or another annotation
//   processor (PROCESSOR_ANNOTATIONS), or annotated so itself, is incomplete
//   (GENERATED_REASON): the generated members may call it and are not read.
// - The target's own text unreadable (too large, gone) or its declaration not found there:
//   incomplete (UNREAD_TARGET_REASON).
// - A query jdtls rejects with `-32603 Internal error` is asked once more (`retryRejected`):
//   J6 measured 6 of 164 incomingCalls rejected at the editor's 8 parallel queries, all on
//   targets overriding a widely implemented method (Object.equals, toString, TypeAdapter.read),
//   and none of 61 on the same PR one query at a time. A second rejection, or any other, is
//   incomplete with its message: the shared `queryHierarchy` keeps every rejection as the reason.

// - At most JAVA_CALLER_QUERY_LIMIT Java caller queries run at once (`queryGate`); the
//   analysis' other languages keep its concurrency. The rest wait in a queue.
// - An empty incoming-calls answer for an override or an overridable method is incomplete
//   (EMPTY_ANSWER_REASON): VS Code's `vscode.provideIncomingCalls` returns `[]` when the
//   provider fails, so a jdtls -32603 can reach the editor as "no callers" (J6 pass 2).
// - While the Java language server imports or rebuilds the projects (`serverStatus`, from
//   redhat.java's API and jdtls' project diagnostics in the editor, ./server-status.js), or
//   while a project's build path is broken, an answer is incomplete with the reason it gives
//   (J6 #1904: extras/metrics/proto at compliance 1.6, which jdtls does not build, had none
//   of their calls listed).

const path = require('path');
const { createQueryGate } = require('../callers-from-hierarchy');
const { readTextOfOffsets } = require('../../engine/textpos');
const { withDeadline } = require('../../engine/deadline');
const { realClock } = require('../../engine/clock');

/** @typedef {import('../../engine/caller-contract').CallerRow} CallerRow */

// Budget: Java caller queries in flight at once, per resolver (count). Default 2, approved by
// the owner (J6 pass 2). Owner: Java's editor extras; enforced by `queryGate`, through which
// the resolver's and the harness's `queryHierarchy` run every Java call-hierarchy query,
// retries included. Exhaustion: the next query waits in a first-come queue, never fails; the
// queue holds at most the analysis' parallel queries (impactTree.concurrency, at most 32).
// Why: jdtls rejected 3-6% of incomingCalls with -32603 at 8 parallel queries (J6), 0 at 1.
const JAVA_CALLER_QUERY_LIMIT = 2;
const IMPORTED_DURING_REASON = 'the Java language server re-imported the project while the query ran';
const EMPTY_ANSWER_REASON = 'the language server returned no callers for a method that overrides or can be overridden; an empty answer can hide a failed query';

// The largest Java file read, for a caller's sites or the target's declaration, in bytes on
// disk. Hand-written Java files are rarely above a few hundred KiB; a larger one (generated
// parsers) is not read: its sites count as unknown, and a target in it is incomplete. Each
// query reads each distinct file at most once and keeps the text only while it runs.
const MAX_JAVA_FILE_BYTES = 2 * 1024 * 1024;

// How long one implementations query (the overridden check) may take, in milliseconds.
// Owner: this module, enforced around `services.implementations`. One query per caller
// query, only for an overridable method. 10 s leaves room for a wide hierarchy (J0: an
// incomingCalls over an `Iterator` implementer took 11 s). Exhaustion: the answer is
// incomplete, "could not be listed (timed out …)".
const IMPLEMENTATIONS_TIMEOUT_MS = 10000;

// jdtls' default project, where it puts files outside every imported project.
const DEFAULT_PROJECT = 'jdt.ls-java-project';

const VALUE_USE_REASON = 'referenced-as-value';
const OVERRIDES_REASON = 'overrides or implements a supertype method: the language server lists the supertype method\'s callers with its own, and a listed call may run another implementation';
const OVERRIDDEN_REASON = 'overridden in the workspace: a listed call may run an override instead';
const IMPLICIT_SUPER_REASON = 'a no-argument constructor of a class that is not final: a subclass constructor\'s implicit super() call is not listed';
const UNBUILT_REASON = 'no new, this(…) or super(…) call found: it may be built by reflection, a framework or a subclass\'s implicit super()';
const DI_FACTORY_REASON = 'a dependency-injection factory method: the container calls it, which is not followed';
const GENERATED_REASON = 'members generated by annotation processing are not read';
// jdtls' rejection of a call-hierarchy query it fails inside (JSON-RPC -32603), as the harness
// (`(code -32603)`) and VS Code (`Internal error.`) report it.
const TRANSIENT_REJECTION = /\(code -32603\)|\bInternal error\b/;
/** @param {string} reason */
const isTransientRejection = (reason) => TRANSIENT_REJECTION.test(reason);
const UNREAD_TARGET_REASON = 'its declaration could not be read, so whether it overrides another method is not known';

// Simple names; a qualified annotation (`@lombok.Data`) is read by its last segment.
const DI_CLASS_ANNOTATIONS = new Set(['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'Named', 'Singleton', 'ApplicationScoped', 'RequestScoped', 'SessionScoped', 'Dependent']);
const DI_CONSTRUCTOR_ANNOTATIONS = new Set(['Inject', 'Autowired']);
const DI_FACTORY_ANNOTATIONS = new Set(['Bean', 'Provides', 'Produces']);
const PROCESSOR_ANNOTATIONS = new Set([
  'Data', 'Getter', 'Setter', 'Builder', 'SuperBuilder', 'Value', 'RequiredArgsConstructor', 'AllArgsConstructor',
  'NoArgsConstructor', 'ToString', 'EqualsAndHashCode', 'With', 'Wither', 'Delegate', 'Accessors', 'FieldDefaults',
  'UtilityClass', 'Singular', 'AutoValue', 'AutoBuilder', 'AutoOneOf', 'Immutable', 'Mapper',
]);
// `Object`'s overridable methods by name and parameter count.
const OBJECT_METHODS = new Map([['equals', 1], ['hashCode', 0], ['toString', 0], ['clone', 0], ['finalize', 0]]);

/**
 * The text with comments, string, text-block and char literals blanked to spaces (line
 * breaks kept), same length, so offsets still match. Pure; one pass.
 * @param {string} text
 * @returns {string}
 */
function maskJava(text) {
  const out = text.split('');
  const blank = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? n : nl;
      blank(i, end); i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      blank(i, end); i = end;
    } else if (c === '"' && text.startsWith('"""', i)) {
      let j = i + 3;
      while (j < n && !text.startsWith('"""', j)) j += text[j] === '\\' ? 2 : 1;
      const end = Math.min(n, j + 3);
      blank(i, end); i = end;
    } else if (c === '"' || c === '\'') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const end = Math.min(n, j + 1);
      blank(i, end); i = end;
    } else {
      i++;
    }
  }
  return out.join('');
}

const isIdentChar = (/** @type {string|undefined} */ ch) => !!ch && /[\w$]/.test(ch);

/**
 * Whether a call site in `masked` (maskJava's) is a call (true), a method reference, that
 * is a value use (false), or unknown (null: no text, a range outside it, or a site that is
 * not an identifier in code). Pure.
 * @param {string|null} masked @param {{ start: number, end: number }} site
 * @returns {boolean|null}
 */
function isJavaCallSite(masked, site) {
  if (typeof masked !== 'string') return null;
  const { start, end } = site;
  if (!Number.isInteger(start) || !Number.isInteger(end) || !(0 <= start && start < end && end <= masked.length)) return null;
  if (!isIdentChar(masked[start]) || !isIdentChar(masked[end - 1])) return null;
  let i = start - 1;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  return !(i >= 1 && masked[i] === ':' && masked[i - 1] === ':');
}

/**
 * Where the declaration or header ending at `end` starts: just after the previous `;`, `{`
 * or `}` outside parentheses (an annotation's `{…}` argument is inside them). Pure.
 * @param {string} masked @param {number} end
 */
function headerStartBefore(masked, end) {
  let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === ')') depth++;
    else if (ch === '(') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) return i + 1;
  }
  return 0;
}

/** @param {string} header @returns {string[]} Annotation simple names in a header. */
const annotationsOf = (header) => [...header.matchAll(/@\s*([\w$]+(?:\s*\.\s*[\w$]+)*)/g)]
  .map((m) => (m[1].split('.').pop() || '').trim())
  .filter((name) => name !== 'interface');

/** @param {string} header @returns {Set<string>} Its words outside annotations' arguments. */
function wordsOf(header) {
  let depth = 0;
  let plain = '';
  for (const ch of header) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) plain += ch;
  }
  return new Set(plain.replace(/@\s*[\w$.]+/g, ' ').split(/[^\w$]+/).filter(Boolean));
}

/**
 * The declaration whose name is at `pos` and the type whose body holds it, read from the
 * masked text. Null when `pos` is not at a name followed by `(`. Pure; O(length of text).
 * @param {string} masked @param {number} pos
 * @returns {null | {
 *   name: string, params: number, annotations: string[], modifiers: Set<string>,
 *   isConstructor: boolean,
 *   type: { kind: 'class'|'interface'|'enum'|'record'|'anonymous'|'body'|'none', name: string|null,
 *     annotations: string[], modifiers: Set<string>, supertypes: string[] } }}
 */
function declarationAt(masked, pos) {
  if (!(Number.isInteger(pos) && pos >= 0 && pos < masked.length) || !isIdentChar(masked[pos])) return null;
  let e = pos;
  while (e < masked.length && isIdentChar(masked[e])) e++;
  const name = masked.slice(pos, e);
  let open = e;
  while (open < masked.length && /\s/.test(masked[open])) open++;
  if (masked[open] !== '(') return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return null;
  const inside = masked.slice(open + 1, close).trim();
  const params = inside ? inside.split(',').length : 0; // a type argument's comma over-counts; only 0 and 1 are read
  const headerStart = headerStartBefore(masked, pos);
  const header = masked.slice(headerStart, pos);
  // The `{` of the body that holds the declaration: the innermost one still open there.
  /** @type {number[]} */
  const stack = [];
  for (let i = 0; i < headerStart; i++) {
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}') stack.pop();
  }
  const bodyOpen = stack.length ? stack[stack.length - 1] : -1;
  /** @type {NonNullable<ReturnType<typeof declarationAt>>['type']} */
  let type = { kind: 'none', name: null, annotations: [], modifiers: new Set(), supertypes: [] };
  if (bodyOpen >= 0) {
    const typeHeader = masked.slice(headerStartBefore(masked, bodyOpen), bodyOpen);
    const named = /(?:^|[^\w$@])(@\s*interface|class|interface|enum|record)\s+([\w$]+)/.exec(typeHeader);
    const anonymous = /\bnew\s+([\w$.]+)\s*(?:<[^]*>)?\s*\([^]*\)\s*$/.exec(typeHeader);
    if (named) {
      const kind = /** @type {'class'|'interface'|'enum'|'record'} */ (named[1].startsWith('@') ? 'interface' : named[1]);
      const after = typeHeader.slice(named.index + named[0].length);
      const clause = /\b(?:extends|implements)\b([^]*)$/.exec(after);
      const supertypes = clause
        ? clause[1].replace(/<[^<>]*>/g, '').replace(/<[^<>]*>/g, '').split(/\bimplements\b|,/).map((s) => s.trim().split('.').pop() || '').filter((s) => /^[\w$]+$/.test(s))
        : [];
      const prefix = typeHeader.slice(0, named.index + named[0].length - named[2].length);
      type = { kind, name: named[2], annotations: annotationsOf(prefix), modifiers: wordsOf(prefix), supertypes };
    } else if (anonymous) {
      type = { kind: 'anonymous', name: null, annotations: [], modifiers: new Set(), supertypes: [anonymous[1].split('.').pop() || anonymous[1]] };
    } else {
      // An enum constant's body (`A { … }`, `B(1) { … }`) or a block.
      type = { kind: 'body', name: null, annotations: [], modifiers: new Set(), supertypes: [] };
    }
  }
  const isConstructor = type.name === name && (type.kind === 'class' || type.kind === 'enum' || type.kind === 'record');
  return { name, params, annotations: annotationsOf(header), modifiers: wordsOf(header), isConstructor, type };
}

/**
 * Whether `file` (absolute) is outside `repoRoot` (absolute), or in jdtls' default project.
 * @param {string|null} repoRoot @param {string} file
 */
function notWorkspaceFile(repoRoot, file) {
  if (file.split(/[\\/]/).includes(DEFAULT_PROJECT)) return true;
  if (!repoRoot) return false;
  const rel = path.relative(repoRoot, file);
  return rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel));
}

/**
 * Sorts callers: those outside the workspace are dropped; each other caller's sites into
 * calls, value uses and unknown ones, as Go's `filterValueUses`. Pure apart from `readText`.
 * @param {CallerRow[]} callers
 * @param {(file: string) => string|null} readText
 * @param {string|null} repoRoot
 * @returns {{ kept: CallerRow[], dropped: number, valueUses: number, notWorkspace: number }}
 */
function filterJavaCallers(callers, readText, repoRoot) {
  /** @type {Map<string, string|null>} */
  const masks = new Map();
  const maskOf = (/** @type {string} */ file) => {
    if (!masks.has(file)) { const t = readText(file); masks.set(file, typeof t === 'string' ? maskJava(t) : null); }
    return /** @type {string|null} */ (masks.get(file));
  };
  /** @type {CallerRow[]} */
  const kept = [];
  let dropped = 0;
  let valueUses = 0;
  let notWorkspace = 0;
  for (const caller of callers) {
    if (notWorkspaceFile(repoRoot, caller.file)) { notWorkspace++; dropped++; continue; }
    const sites = caller.callSites || [];
    if (!sites.length) { kept.push(caller); continue; }
    const masked = maskOf(caller.file);
    const rest = sites.filter((site) => isJavaCallSite(masked, site) !== false);
    const values = sites.length - rest.length;
    valueUses += values;
    if (!values) kept.push(caller);
    else if (!rest.length) dropped++;
    else kept.push({ ...caller, callSites: rest, sites: rest.length });
  }
  return { kept, dropped, valueUses, notWorkspace };
}

/** @param {unknown} e */
const messageOf = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));

/**
 * Why the overridable method at `pos` may run an override, or null. Never rejects.
 * @param {{ services: import('../types').LanguageServices|null, trace: (m: string) => void, timeoutMs: number,
 *   clock: import('../../engine/clock').Clock }} env
 * @param {string} file @param {number} pos
 * @returns {Promise<string|null>}
 */
async function overriddenReason({ services, trace, timeoutMs, clock }, file, pos) {
  if (!services) return null;
  /** @type {import('../types').ServerLocation[]|null} */
  let locations;
  try {
    locations = await withDeadline(() => services.implementations({ file, side: 'head' }, pos), timeoutMs, 'the implementations query', clock);
  } catch (e) {
    return `whether it is overridden could not be listed: ${messageOf(e)}`;
  }
  if (locations == null) return 'whether it is overridden could not be listed (no answer)';
  const others = locations.filter((l) => !(l.file === file && l.start != null && l.end != null && l.start <= pos && pos < l.end));
  if (!others.length) return null;
  trace(`java: ${file}@${pos} is overridden by ${others.length} method(s), e.g. ${others[0].file}`);
  return OVERRIDDEN_REASON;
}

/**
 * The reasons a target's answer is incomplete, read from its declaration (and, for an
 * overridable method, one implementations query). Never rejects.
 * @param {{ services: import('../types').LanguageServices|null, readText: (file: string) => string|null,
 *   trace: (m: string) => void, timeoutMs: number, clock: import('../../engine/clock').Clock }} env
 * @param {string} file @param {number} pos
 * @param {boolean} hasCallers Whether the answer lists any caller.
 * @returns {Promise<string[]>}
 */
async function targetReasons(env, file, pos, hasCallers) {
  const text = env.readText(file);
  const decl = typeof text === 'string' ? declarationAt(maskJava(text), pos) : null;
  if (!decl) return [UNREAD_TARGET_REASON];
  const { type } = decl;
  /** @type {string[]} */
  const reasons = [];
  const has = (/** @type {string} */ m) => decl.modifiers.has(m);
  if ([...type.annotations, ...decl.annotations].some((a) => PROCESSOR_ANNOTATIONS.has(a))) reasons.push(GENERATED_REASON);
  if (decl.isConstructor) {
    const di = type.annotations.some((a) => DI_CLASS_ANNOTATIONS.has(a)) || decl.annotations.some((a) => DI_CONSTRUCTOR_ANNOTATIONS.has(a));
    if (!di && type.kind === 'class' && !type.modifiers.has('final') && decl.params === 0) reasons.push(IMPLICIT_SUPER_REASON);
    else if (!di && !hasCallers) reasons.push(UNBUILT_REASON);
    return reasons;
  }
  if (decl.annotations.some((a) => DI_FACTORY_ANNOTATIONS.has(a))) reasons.push(DI_FACTORY_REASON);
  if (has('static') || has('private')) return reasons;
  const objectArity = OBJECT_METHODS.get(decl.name);
  const overrides = decl.annotations.includes('Override')
    || (objectArity !== undefined && objectArity === decl.params)
    || type.kind === 'anonymous' || type.kind === 'body';
  if (overrides) {
    const supers = type.supertypes.length ? type.supertypes.join(', ') : 'its supertype';
    reasons.push(`${OVERRIDES_REASON} (${supers}.${decl.name})`);
    if (!hasCallers) reasons.push(EMPTY_ANSWER_REASON);
    return reasons;
  }
  const overridable = !has('final') && type.kind !== 'record' && type.kind !== 'none'
    && !type.modifiers.has('final');
  if (overridable && !hasCallers) reasons.push(EMPTY_ANSWER_REASON);
  if (overridable) {
    const r = await overriddenReason(env, file, pos);
    if (r) reasons.push(r);
  }
  return reasons;
}

/**
 * Java's caller extras. Holds no state between queries but the query gate's queue.
 * @param {{ trace?: (message: string) => void, readText?: (file: string) => string|null,
 *   services?: import('../types').LanguageServices|null, repoRoot?: string|null, timeoutMs?: number,
 *   clock?: import('../../engine/clock').Clock, serverStatus?: import('./server-status').JavaServerStatus|null,
 *   queryLimit?: number }} [options]
 *   `serverStatus`: the Java language server's import state (./server-status.js); absent: none
 *   known (tests, the harness). `queryLimit`: JAVA_CALLER_QUERY_LIMIT (tests).
 *   `readText` (tests): a file's text; by default through src/engine/textpos.js, the text
 *   the sites' offsets were converted from, up to MAX_JAVA_FILE_BYTES. `services`: where an
 *   overridable method's implementations are asked; without it none is asked (tests).
 *   `repoRoot`: callers outside it are dropped. `timeoutMs`: IMPLEMENTATIONS_TIMEOUT_MS, timed by `clock` (src/engine/clock.js).
 * @returns {import('../types').EditorCallerExtras}
 */
function createJavaEditorExtras({
  trace = () => {}, readText = (file) => readTextOfOffsets(file, { maxBytes: MAX_JAVA_FILE_BYTES }),
  services = null, repoRoot = null, timeoutMs = IMPLEMENTATIONS_TIMEOUT_MS, clock = realClock,
  serverStatus = null, queryLimit = JAVA_CALLER_QUERY_LIMIT,
} = {}) {
  const status = serverStatus || { busyReason: () => null, epoch: () => 0 };
  return {
    queryGate: createQueryGate(queryLimit),
    // Java never suppresses a query.
    suppressedReason: 'caller query not asked',
    // Callers dropped for using the method only as a value. Callers in jdtls' default
    // project or outside the repository are dropped too, but only traced: they are not
    // value uses.
    droppedStat: 'valueUsesDropped',
    retryRejected: isTransientRejection,
    query(file, pos) {
      let sawValueUse = false;
      let kept = 0;
      // The server's state when the query starts: busy then, busy at the end, or an import
      // that began or ended in between (the epoch moved), and the answer may be the old one.
      const busyAtStart = status.busyReason();
      const epochAtStart = status.epoch();
      return {
        isSuppressed: () => false,
        filter(callers) {
          const r = filterJavaCallers(callers, readText, repoRoot);
          if (r.valueUses) {
            sawValueUse = true;
            trace(`java: ${r.valueUses} method reference(s) among ${callers.length} caller(s)`);
          }
          if (r.notWorkspace) trace(`java: dropped ${r.notWorkspace} caller(s) in jdtls' default project or outside the repository`);
          kept = r.kept.length;
          return { kept: r.kept, dropped: r.dropped - r.notWorkspace };
        },
        async moreCallers() {
          const busy = busyAtStart || status.busyReason()
            || (status.epoch() !== epochAtStart ? IMPORTED_DURING_REASON : null);
          const serverReasons = busy ? [busy] : [];
          if (sawValueUse) return { callers: [], incompleteReason: [...serverReasons, VALUE_USE_REASON].join('; ') };
          const reasons = [...serverReasons, ...await targetReasons({ services, readText, trace, timeoutMs, clock }, file, pos, kept > 0)];
          return { callers: [], incompleteReason: reasons.length ? reasons.join('; ') : null };
        },
      };
    },
    // jdtls' answer is the whole workspace's, tests included.
    unseenUsers: async () => null,
    clear() {},
  };
}

module.exports = {
  isTransientRejection,
  createJavaEditorExtras, filterJavaCallers, isJavaCallSite, maskJava, declarationAt, targetReasons,
  JAVA_CALLER_QUERY_LIMIT, EMPTY_ANSWER_REASON, IMPORTED_DURING_REASON,
  MAX_JAVA_FILE_BYTES, IMPLEMENTATIONS_TIMEOUT_MS, VALUE_USE_REASON, OVERRIDES_REASON, OVERRIDDEN_REASON,
  IMPLICIT_SUPER_REASON, UNBUILT_REASON, DI_FACTORY_REASON, GENERATED_REASON, UNREAD_TARGET_REASON,
};
