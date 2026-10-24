'use strict';
/**
 * G2 end to end: the real pipeline (`analyze()`) and Go provider against gopls, on a cli/cli
 * clone, through the harness (base-side symbols via temporary files, callers from the call
 * hierarchy). A development script, not part of `npm test`: it needs gopls and the clone.
 *
 *   node test/lsp-harness/go-e2e.js <absolute path to cli/cli clone> [--base base-14752] [--gopls path]
 *
 * The clone must have the PR's head checked out and a clean worktree (`pr` mode). It is
 * read as data: nothing in it is run except by gopls itself. Prints the changed, added
 * and deleted Go functions with their kinds and callers, the outside-function ranges, the
 * warnings and the files not analysed, then checks the names PR #14752 is known to add and
 * delete. The run is bounded by OVERALL_DEADLINE_MS; gopls is stopped on exit.
 */

const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../../src/engine/analyze');
const { createGoplsServices } = require('./gopls-services');
const { languageServicesOver, createHierarchyResolver } = require('./harness-languages');
const { goProvider } = require('../../src/languages/go/provider');

/** Whole run, cold gopls included (G0: first answers within seconds on a warm disk cache). */
const OVERALL_DEADLINE_MS = 15 * 60 * 1000;

// From `git diff base-14752...pr-14752 -- '*.go'` (non-test files).
const EXPECTED_DELETED = ['applyTestingExpiryOverride', 'refreshTokenExpired', 'testingExpiryOverrideFromEnv'];
const EXPECTED_ADDED = ['simulateRefreshTokenExpired', 'configFromEnv', 'lifetimeFromEnv', 'Config', 'format', 'builtWithTags', 'normalizeBuildTags'];

/** @param {string[]} args @param {string} flag @param {string} fallback */
const option = (args, flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };

async function main() {
  const args = process.argv.slice(2);
  const repo = args[0];
  if (!repo || !path.isAbsolute(repo)) throw new Error('usage: node go-e2e.js <absolute path to cli/cli clone> [--base ref] [--gopls path]');
  const base = option(args, '--base', 'base-14752');
  const goplsPath = option(args, '--gopls', path.join(os.homedir(), 'go', 'bin', 'gopls'));
  const gopls = createGoplsServices({ repo, goplsPath });
  const killTimer = setTimeout(() => { console.error('overall deadline hit, killing gopls'); gopls.client.proc.kill('SIGKILL'); }, OVERALL_DEADLINE_MS);
  const started = Date.now();
  try {
    await gopls.start({ deadlineMs: 60000 });
    const services = languageServicesOver(gopls, { repoRoot: repo });
    /** @type {string[]} */
    const resolvers = [];
    const result = await analyze(repo, {
      mode: 'pr', base, allowLocalBase: true, skipForest: true, deferTestReach: false, depth: 2,
      languageServices: services,
      makeResolver: (/** @type {{ language: string, component: string }} */ { language, component }) => {
        resolvers.push(`${language}:${component}`);
        // The Go provider's caller extras, applied as the editor's resolver applies them
        // (G4: value uses are not calls; a file outside the active build says so).
        const extras = language === 'go' && goProvider.editorCallers
          ? goProvider.editorCallers({ ts: null, services, repoRoot: repo, trace: () => {}, filterInherited: false, onWarmupRetry: () => {} })
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
      const callers = c.callers.map((/** @type {any} */ x) => `${x.label}${x.test ? ' [test]' : ''} (${rel(x.file)}, ${x.callState})`);
      console.log(`  ${c.added ? 'ADDED  ' : 'CHANGED'} ${c.relPath}:${c.startLine}-${c.endLine} ${c.label}  key=${c.key}`);
      console.log(`      kinds: ${c.kinds.map((/** @type {any} */ k) => k.id).join(', ')}${c.baseSig && c.baseSig !== c.headSig ? `\n      base: ${c.baseSig}\n      head: ${c.headSig}` : `  sig: ${c.headSig}`}`);
      console.log(`      callers: ${c.callerState}${c.callersComplete ? '' : ` (incomplete: ${c.callersIncompleteReason})`}; tests: ${c.testState}`);
      for (const line of callers) console.log(`        - ${line}`);
    }
    console.log('\ndeleted:');
    for (const d of result.deleted) console.log(`  DELETED ${d.relPath}:${d.startLine}-${d.endLine} ${d.label}`);
    console.log('\noutside functions:');
    for (const o of result.outside) console.log(`  ${o.relPath}: ${JSON.stringify(o.ranges)}`);
    console.log('\nother files (listed, no symbol rows):');
    for (const f of result.otherFiles) console.log(`  ${f.status} ${f.path}${f.noCallable ? ' (no changed function)' : ''}`);

    const added = result.allChanged.filter((c) => c.added).map((c) => c.simpleName);
    const deleted = result.deleted.map((d) => d.simpleName);
    const missingAdded = EXPECTED_ADDED.filter((n) => !added.includes(n));
    const missingDeleted = EXPECTED_DELETED.filter((n) => !deleted.includes(n));
    console.log(`\nexpected added present: ${missingAdded.length ? `MISSING ${missingAdded.join(', ')}` : 'all'}`);
    console.log(`expected deleted present: ${missingDeleted.length ? `MISSING ${missingDeleted.join(', ')}` : 'all'}`);
    console.log(`added beyond the expected list: ${added.filter((n) => !EXPECTED_ADDED.includes(n)).join(', ') || 'none'}`);
    console.log(`deleted beyond the expected list: ${deleted.filter((n) => !EXPECTED_DELETED.includes(n)).join(', ') || 'none'}`);
    if (missingAdded.length || missingDeleted.length) process.exitCode = 1;
  } finally {
    clearTimeout(killTimer);
    await gopls.close().catch((/** @type {Error} */ e) => console.error(`closing gopls: ${e.message}`));
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
