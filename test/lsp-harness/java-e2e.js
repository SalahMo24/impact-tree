'use strict';
/**
 * J2 end to end: the real pipeline (`analyze()`) and Java provider against jdtls, on a
 * google/gson worktree, through the harness (base-side symbols via temporary files, callers
 * from the call hierarchy with the shared defaults; Java's caller extras are J4's).
 * A development script, not part of `npm test`: it needs jdtls (J-D1) and the worktree.
 *
 *   node test/lsp-harness/java-e2e.js [absolute path to gson worktree] [--base sha] [--tools dir] [--data dir]
 *
 * The worktree (default ~/Projects/impact-tree-test-repos/gson-e2e, a `git worktree` of the
 * gson clone, so the clone itself stays at main for J3's oracle) must have PR #3096's head
 * (dae37cf0, "Fix some adapter exceptions not including JSON document location") checked out
 * and be clean (`pr` mode), with `--base` at its parent 119818bc. It is read as data: nothing
 * in it is run, except by jdtls importing it (as J0 did). jdtls' `-data` is kept under
 * java-tools/jdtls-data/gson-e2e between runs (warm start). Prints the changed, added and
 * deleted Java methods with their callers, the outside-method ranges, the warnings and the
 * files not analysed, then checks the keys against the ones the diff shows, and each changed
 * method's callers with Java's caller extras (J4): complete or incomplete with the override
 * reason, and a known caller listed. Signature kinds are not checked (J3's oracle does). The run is bounded by OVERALL_DEADLINE_MS;
 * jdtls is stopped on exit.
 */

const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../../src/engine/analyze');
const { createJdtlsServices, DEFAULT_TOOLS } = require('./jdtls-services');
const { languageServicesOver, createHierarchyResolver } = require('./harness-languages');
const { javaProvider } = require('../../src/languages/java/provider');
const { OVERRIDES_REASON } = require('../../src/languages/java/editor-extras');

/** Whole run, a cold import included (J0: ≈ 30 s with a filled m2, 78 s with an empty one). */
const OVERALL_DEADLINE_MS = 5 * 60 * 1000;
const BASE = '119818bc666d3b9f897d6c0ca7546ce28e9bbcac';

// Hand-checked from `git diff 119818bc..dae37cf0`: every method whose lines the diff touches.
// - MapTypeAdapterFactory.java: two hunks in the inner class Adapter's `read`.
// - TypeAdapters.java: imports (outside); `atomicLongArrayAdapter`'s anonymous adapter (its
//   body, P-D5); the anonymous adapters of the CHARACTER, URL and URI fields (keyed by the
//   field: no method's body).
// - Tests: the pipeline lists test files without their methods (as py-e2e's test file):
//   the five changed test files are checked as listed, with no changed method.
const EXPECTED_CHANGED = [
  'MapTypeAdapterFactory.Adapter.read(JsonReader)',
  'TypeAdapters.atomicLongArrayAdapter(TypeAdapter)',
  'TypeAdapters.CHARACTER.read(JsonReader)',
  'TypeAdapters.URL.read(JsonReader)',
  'TypeAdapters.URI.read(JsonReader)',
];
/** @type {string[]} */
const EXPECTED_ADDED = [];
const EXPECTED_TEST_FILES = ['DefaultTypeAdaptersTest', 'JavaUtilConcurrentAtomicTest', 'MapAsArrayTypeAdapterTest', 'MapTest', 'PrimitiveCharacterTest']
  .map((n) => `gson/src/test/java/com/google/gson/functional/${n}.java`);
// The import lines TypeAdapters.java's diff removes (after line 22) and adds (line 37).
const EXPECTED_OUTSIDE = '[[22.5,22.5],[37,37]]';
/** @type {string[]} */
const EXPECTED_DELETED = [];
// Callers (J4). The four `read(JsonReader)` override `TypeAdapter.read`: incomplete with the
// override reason (jdtls lists `TypeAdapter.read`'s 32 callers for each, J0 §3), e.g.
// `Gson.fromJson(JsonReader, TypeToken)`, which calls `adapter.read(reader)`. The public
// static `atomicLongArrayAdapter` is complete: `GsonBuilder.createFactories` calls it.
// `knownCaller`: part of a caller's label (jdtls' item name) known to call it.
/** @type {Record<string, { overrides: boolean, knownCaller: string }>} */
const EXPECTED_CALLERS = {
  'MapTypeAdapterFactory.Adapter.read(JsonReader)': { overrides: true, knownCaller: 'fromJson(JsonReader, TypeToken' },
  'TypeAdapters.atomicLongArrayAdapter(TypeAdapter)': { overrides: false, knownCaller: 'createFactories(' },
  'TypeAdapters.CHARACTER.read(JsonReader)': { overrides: true, knownCaller: 'fromJson(JsonReader, TypeToken' },
  'TypeAdapters.URL.read(JsonReader)': { overrides: true, knownCaller: 'fromJson(JsonReader, TypeToken' },
  'TypeAdapters.URI.read(JsonReader)': { overrides: true, knownCaller: 'fromJson(JsonReader, TypeToken' },
};

/** @param {string[]} args @param {string} flag @param {string} fallback */
const option = (args, flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };

/** @param {string[]} expected @param {string[]} got @returns {string} */
function compare(expected, got) {
  const missing = expected.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !expected.includes(n));
  return missing.length || extra.length || got.length !== new Set(got).size
    ? `MISMATCH missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`
    : `exactly the ${expected.length} expected`;
}

async function main() {
  const args = process.argv.slice(2);
  const repo = args[0] && !args[0].startsWith('--') ? args[0] : path.join(os.homedir(), 'Projects', 'impact-tree-test-repos', 'gson-e2e');
  if (!path.isAbsolute(repo)) throw new Error('usage: node java-e2e.js [absolute path to gson worktree] [--base sha] [--tools dir] [--data dir]');
  const base = option(args, '--base', BASE);
  const tools = option(args, '--tools', DEFAULT_TOOLS);
  const dataDir = option(args, '--data', path.join(tools, 'jdtls-data', 'gson-e2e'));
  const jdtls = createJdtlsServices({ repo, tools, dataDir });
  const killTimer = setTimeout(() => { console.error('overall deadline hit, killing jdtls'); jdtls.client.proc.kill('SIGKILL'); }, OVERALL_DEADLINE_MS);
  const started = Date.now();
  try {
    await jdtls.start();
    console.log(`jdtls ready in ${((Date.now() - started) / 1000).toFixed(1)} s (-data ${dataDir})`);
    const services = languageServicesOver(/** @type {any} */ (jdtls), { repoRoot: repo });
    /** @type {string[]} */
    const resolvers = [];
    /** @type {string[]} */
    const traces = [];
    const result = await analyze(repo, {
      mode: 'pr', base, allowLocalBase: true, skipForest: true, deferTestReach: false, depth: 1,
      languageServices: services,
      makeResolver: (/** @type {{ language: string, component: string }} */ { language, component }) => {
        resolvers.push(`${language}:${component}`);
        // Java's caller extras (J4), applied as the editor's resolver applies them.
        const extras = language === 'java' && javaProvider.editorCallers
          ? javaProvider.editorCallers({ ts: null, services, repoRoot: repo, trace: (m) => traces.push(m), filterInherited: false, onWarmupRetry: () => {} })
          : null;
        return createHierarchyResolver(services, { extras });
      },
    });
    const rel = (/** @type {string} */ f) => path.relative(repo, f);
    console.log(`analysed in ${((Date.now() - started) / 1000).toFixed(1)} s; base ${result.base.ref} ${result.base.sha.slice(0, 12)}`);
    console.log(`changed source files: ${result.changedFileCount}; units: ${resolvers.join(', ')}`);
    console.log('\nwarnings:');
    for (const w of result.warnings) console.log(`  - ${w}`);
    console.log(`unanalysable: ${JSON.stringify(result.unanalysable)}`);
    console.log('\nchanged / added:');
    for (const c of result.allChanged.slice().sort((a, b) => a.relPath.localeCompare(b.relPath) || a.startLine - b.startLine)) {
      console.log(`  ${c.added ? 'ADDED  ' : 'CHANGED'} ${c.relPath}:${c.startLine}-${c.endLine} ${c.label}  key=${c.key}  kinds: ${c.kinds.map((/** @type {any} */ k) => k.id).join(', ')}`);
      console.log(`      callers: ${c.callerState}${c.callersComplete ? '' : ` (incomplete: ${c.callersIncompleteReason})`}; ${c.callers.length} listed`);
      for (const x of c.callers) console.log(`        - ${x.label}${x.test ? ' [test]' : ''} (${rel(x.file)})`);
    }
    console.log('\ndeleted:');
    for (const d of result.deleted) console.log(`  DELETED ${d.relPath}:${d.startLine}-${d.endLine} ${d.label}`);
    console.log('\noutside methods:');
    for (const o of result.outside) console.log(`  ${o.relPath}: ${JSON.stringify(o.ranges)}`);
    console.log('\nother files (listed, no symbol rows):');
    for (const f of result.otherFiles) console.log(`  ${f.status} ${f.path}${f.noCallable ? ' (no changed method)' : ''}${f.notAnalysed ? ` NOT ANALYSED: ${f.notAnalysed.reason}` : ''}`);

    const changed = result.allChanged.filter((c) => !c.added).map((c) => c.key);
    const added = result.allChanged.filter((c) => c.added).map((c) => c.key);
    const deleted = result.deleted.map((d) => d.key);
    const lines = [
      `check changed: ${compare(EXPECTED_CHANGED, changed)}`,
      `check added: ${compare(EXPECTED_ADDED, added)}`,
      `check deleted: ${compare(EXPECTED_DELETED, deleted)}`,
      `check test files listed with no changed method: ${compare(EXPECTED_TEST_FILES, result.otherFiles.filter((f) => f.noCallable && !f.notAnalysed).map((f) => f.path))}`,
      `check outside: ${JSON.stringify(result.outside.map((o) => [o.relPath, o.ranges])) === JSON.stringify([['gson/src/main/java/com/google/gson/internal/bind/TypeAdapters.java', JSON.parse(EXPECTED_OUTSIDE)]]) ? 'yes' : 'NO'}`,
      `check every Java file analysed: ${result.unanalysable.length ? `NO ${JSON.stringify(result.unanalysable)}` : 'yes'}`,
    ];
    // Callers (J4): per method, its state, whether complete and why not, and a known caller.
    const byKey = new Map(result.allChanged.map((/** @type {any} */ c) => [c.key, c]));
    for (const [key, want] of Object.entries(EXPECTED_CALLERS)) {
      const c = byKey.get(key);
      if (!c) { lines.push(`check callers ${key}: NO (not listed)`); continue; }
      const reasonOk = want.overrides
        ? !c.callersComplete && String(c.callersIncompleteReason).startsWith(OVERRIDES_REASON)
        : c.callersComplete === true;
      const known = c.callers.some((/** @type {any} */ x) => x.label.includes(want.knownCaller));
      // jdtls sometimes rejects incomingCalls (`-32603 Internal error`, J2's runs): the right
      // answer then is unknown with that error, never a list read as complete or "none".
      if (c.callerState === 'unknown' && !c.callersComplete && /incomingCalls failed/.test(String(c.callersIncompleteReason))) {
        lines.push(`check callers ${key}: yes (server failed, reported incomplete: ${c.callersIncompleteReason})`);
        continue;
      }
      lines.push(`check callers ${key}: ${reasonOk && known ? 'yes' : 'NO '}(${c.callerState}, ${c.callers.length} listed, ${c.callersComplete ? 'complete' : `incomplete: ${c.callersIncompleteReason}`}; known caller ${want.knownCaller}: ${known ? 'present' : 'MISSING'})`);
    }
    lines.push(`check no caller in jdtls' default project: ${result.allChanged.every((/** @type {any} */ c) => c.callers.every((/** @type {any} */ x) => !x.file.includes('jdt.ls-java-project'))) ? 'yes' : 'NO '}(skipped by the harness: ${jdtls.skippedCallers()}; extras traces: ${traces.filter((t) => /default project/.test(t)).length})`);
    console.log(`\n${lines.join('\n')}`);
    console.log(`wall ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (lines.some((l) => /MISMATCH|: NO /.test(l))) process.exitCode = 1;
  } finally {
    clearTimeout(killTimer);
    await jdtls.close().catch((/** @type {Error} */ e) => console.error(`closing jdtls: ${e.message}`));
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
