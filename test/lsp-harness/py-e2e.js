'use strict';
/**
 * P2 end to end: the real pipeline (`analyze()`) and Python provider against Pyright, on an
 * encode/httpx worktree, through the harness (base-side symbols via temporary files, callers
 * from the call hierarchy with the shared defaults: Python has no caller extras until P4).
 * A development script, not part of `npm test`: it needs Pyright (P-D1) and the worktree.
 *
 *   node test/lsp-harness/py-e2e.js <absolute path to httpx worktree> [--base base-1600] [--pyright path]
 *
 * The worktree must have PR #1600's head (2abb2f2, "Immutable QueryParams") checked out and
 * be clean (`pr` mode), with `--base` at its parent 8fe32c5. It is read as data: nothing in
 * it is run, except by Pyright reading it. Prints the changed, added and deleted Python
 * functions with their callers, the outside-function ranges, the warnings and the files not
 * analysed, then checks the names the diff shows, in `httpx/` (the test file's own test
 * functions are printed, not checked). Signature kinds are not checked: the header parser
 * is P3's. The run is bounded by OVERALL_DEADLINE_MS; Pyright is stopped on exit.
 */

const path = require('node:path');
const { analyze } = require('../../src/engine/analyze');
const { createPyrightServices, DEFAULT_PYRIGHT } = require('./pyright-services');
const { languageServicesOver, createHierarchyResolver } = require('./harness-languages');

/** Whole run, cold Pyright included (P0: first answers within seconds). */
const OVERALL_DEADLINE_MS = 5 * 60 * 1000;

// Hand-checked from `git diff base-1600...pr-1600 -- httpx/` (8fe32c5..2abb2f2): every def
// whose lines the diff touches, by the class it is in.
// - _client.py: one line in BaseClient._merge_queryparams.
// - _models.py: URL.__init__ (the merge call), URL.join (its docstring); QueryParams'
//   __init__ rewritten, docstrings added to keys/values/items/multi_items/get/get_list
//   (get/get_list also `str(key)`); update and __setitem__ moved to the class's end and
//   now raise (same names: changed, not deleted and added); set/add/remove/merge/__hash__ new.
// - _utils.py: flatten_queryparams removed.
const EXPECTED_CHANGED = [
  'BaseClient._merge_queryparams', 'URL.__init__', 'URL.join', 'QueryParams.__init__', 'QueryParams.keys',
  'QueryParams.values', 'QueryParams.items', 'QueryParams.multi_items', 'QueryParams.get', 'QueryParams.get_list',
  'QueryParams.update', 'QueryParams.__setitem__',
];
const EXPECTED_ADDED = ['QueryParams.set', 'QueryParams.add', 'QueryParams.remove', 'QueryParams.merge', 'QueryParams.__hash__'];
const EXPECTED_DELETED = ['flatten_queryparams'];

/** @param {string[]} args @param {string} flag @param {string} fallback */
const option = (args, flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };

/** @param {string[]} expected @param {string[]} got @returns {string} */
function compare(expected, got) {
  const missing = expected.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !expected.includes(n));
  return missing.length || extra.length
    ? `MISMATCH missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`
    : `exactly the ${expected.length} expected`;
}

async function main() {
  const args = process.argv.slice(2);
  const repo = args[0];
  if (!repo || !path.isAbsolute(repo)) throw new Error('usage: node py-e2e.js <absolute path to httpx worktree> [--base ref] [--pyright path]');
  const base = option(args, '--base', 'base-1600');
  const pyright = createPyrightServices({ repo, pyrightPath: option(args, '--pyright', DEFAULT_PYRIGHT) });
  const killTimer = setTimeout(() => { console.error('overall deadline hit, killing Pyright'); pyright.client.proc.kill('SIGKILL'); }, OVERALL_DEADLINE_MS);
  const started = Date.now();
  try {
    await pyright.start({ deadlineMs: 60000 });
    const services = languageServicesOver(/** @type {any} */ (pyright), { repoRoot: repo });
    /** @type {string[]} */
    const resolvers = [];
    const result = await analyze(repo, {
      mode: 'pr', base, allowLocalBase: true, skipForest: true, deferTestReach: false, depth: 1,
      languageServices: services,
      makeResolver: (/** @type {{ language: string, component: string }} */ { language, component }) => {
        resolvers.push(`${language}:${component}`);
        return createHierarchyResolver(services);
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
      console.log(`      callers: ${c.callerState}${c.callersComplete ? '' : ` (incomplete: ${c.callersIncompleteReason})`}; ${c.callers.length} listed${c.callers.length ? `, e.g. ${c.callers.slice(0, 3).map((/** @type {any} */ x) => `${x.label} (${rel(x.file)})`).join(', ')}` : ''}`);
    }
    console.log('\ndeleted:');
    for (const d of result.deleted) console.log(`  DELETED ${d.relPath}:${d.startLine}-${d.endLine} ${d.label}`);
    console.log('\noutside functions:');
    for (const o of result.outside) console.log(`  ${o.relPath}: ${JSON.stringify(o.ranges)}`);
    console.log('\nother files (listed, no symbol rows):');
    for (const f of result.otherFiles) console.log(`  ${f.status} ${f.path}${f.noCallable ? ' (no changed function)' : ''}${f.notAnalysed ? ` NOT ANALYSED: ${f.notAnalysed.reason}` : ''}`);

    const inPackage = (/** @type {{ relPath: string }} */ c) => c.relPath.startsWith('httpx/');
    const changed = result.allChanged.filter((c) => inPackage(c) && !c.added).map((c) => c.key);
    const added = result.allChanged.filter((c) => inPackage(c) && c.added).map((c) => c.key);
    const deleted = result.deleted.filter(inPackage).map((d) => d.key);
    const lines = [
      `check changed: ${compare(EXPECTED_CHANGED, changed)}`,
      `check added: ${compare(EXPECTED_ADDED, added)}`,
      `check deleted: ${compare(EXPECTED_DELETED, deleted)}`,
      `check every Python file analysed: ${result.unanalysable.length ? `NO ${JSON.stringify(result.unanalysable)}` : 'yes'}`,
    ];
    console.log(`\n${lines.join('\n')}`);
    console.log(`wall ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (lines.some((l) => /MISMATCH|: NO /.test(l))) process.exitCode = 1;
  } finally {
    clearTimeout(killTimer);
    await pyright.close().catch((/** @type {Error} */ e) => console.error(`closing Pyright: ${e.message}`));
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
