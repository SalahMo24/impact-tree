'use strict';
// The test manifest: every file `npm test` runs, in the order the old serial chain ran them.
//
// tier 'quick' = measured under about 5 s (pure logic, small fixtures); 'full' = everything, and the
// only tier for the heavy files (real git plus TypeScript analysis). `npm run test:quick` runs the
// quick tier. The // comments give each file's wall time when measured with 4 files running at once;
// re-measure after a large change (test/.timings.json holds the latest local numbers).
//
// heapMb: the child gets --max-old-space-size=<heapMb>. Unit: megabytes. Default: node's own limit.
// Exhaustion: the child dies with an out-of-memory error and the file is reported FAIL.
//
// Adding a test file: list it in SUITE, or in EXCLUDED with the reason it does not run here.
// checkCoverage() fails the runner when a file in test/ is in neither.

const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {object} SuiteEntry
 * @property {string} file repo-relative path, run with cwd = repo root
 * @property {number} [heapMb] --max-old-space-size for the child, megabytes
 * @property {'quick'|'full'} tier
 */

/** @type {SuiteEntry[]} */
const SUITE = [
  { file: 'test/loading.test.js', tier: 'full' },  // 6.5s
  { file: 'test/language-registry.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/typescript-provider.test.js', tier: 'full' },  // 8.2s
  { file: 'test/go-rules.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/python-rules.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/java-rules.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/python-symbols.test.js', tier: 'quick' },  // 6s
  { file: 'test/java-symbols.test.js', tier: 'quick' },  // 2s
  { file: 'test/go-signature.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/python-signature.test.js', tier: 'quick' },
  { file: 'test/java-signature.test.js', tier: 'quick' },
  { file: 'test/java-outline.test.js', tier: 'quick' },
  { file: 'test/java-syntactic.test.js', tier: 'quick' },
  { file: 'test/python-lexer.test.js', tier: 'quick' },  // 0.1s  // 0.2s
  { file: 'test/python-syntactic.test.js', tier: 'quick' },
  { file: 'test/go-syntactic.test.js', tier: 'quick' },
  { file: 'test/go-syntactic-index.test.js', tier: 'quick' },
  { file: 'test/python-syntactic-index.test.js', tier: 'quick' },
  { file: 'test/python-editor-extras.test.js', tier: 'quick' },  // 0.3s
  { file: 'test/python-pyright-project.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/not-analysed.test.js', tier: 'full' },
  { file: 'test/go-call-sites.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/added-by-key.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/apply-caller-extras.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/go-editor-extras.test.js', tier: 'quick' },  // 0.3s
  { file: 'test/java-callers.test.js', tier: 'quick' },
  { file: 'test/server-symbols.test.js', tier: 'quick' },  // 4.6s
  { file: 'test/go-review-identity.test.js', tier: 'quick' },  // 4.1s
  { file: 'test/go-warm-up.test.js', tier: 'quick' },  // 3.4s
  { file: 'test/python-review-identity.test.js', tier: 'quick' },  // 6s
  { file: 'test/python-warm-up.test.js', tier: 'quick' },
  { file: 'test/java-warm-up.test.js', tier: 'quick' },
  { file: 'test/java-review-identity.test.js', tier: 'quick' },  // 3.8s
  { file: 'test/caller-retry.test.js', tier: 'quick' },  // 3.7s
  { file: 'test/services-vscode.test.js', tier: 'quick' },  // 1.9s
  { file: 'test/scope.test.js', tier: 'full' },  // 5.4s
  { file: 'test/local-symbols.test.js', tier: 'quick' },  // 2.3s
  { file: 'test/local-diff.test.js', tier: 'full' },  // 55.0s
  { file: 'test/local-programs.test.js', tier: 'full' },  // 32.4s
  { file: 'test/syntax-regressions.test.js', tier: 'quick' },  // 0.8s
  { file: 'test/remote-regressions.test.js', tier: 'quick' },  // 1.2s
  { file: 'test/editor-regressions.test.js', tier: 'quick' },  // 3.2s
  { file: 'test/review-identity-regressions.test.js', tier: 'quick' },  // 2.1s
  { file: 'test/engine-regressions.test.js', tier: 'full' },  // 63.1s
  { file: 'test/cqrs-cache.test.js', tier: 'quick' },  // 0.6s
  { file: 'test/call-site-classifier.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/unseen-users.test.js', tier: 'quick' },  // 2.6s
  { file: 'test/caller-evidence.test.js', tier: 'full' },  // 5.6s
  { file: 'test/extension-commands.test.js', tier: 'full' },  // 20.7s
  { file: 'test/cancellation.test.js', tier: 'quick' },  // 4.2s
  { file: 'test/request-boundary.test.js', tier: 'quick' },  // 0.7s
  { file: 'test/session-lifecycle.test.js', tier: 'full' },  // 26.6s
  { file: 'test/review-key.test.js', tier: 'full' },  // 33.7s
  { file: 'test/load-typescript.test.js', tier: 'quick' },  // 0.6s
  { file: 'test/github-remote.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/base-ref.test.js', tier: 'full' },  // 5.1s
  { file: 'test/default-base.test.js', tier: 'quick' },  // 1s
  { file: 'test/extension-remotes.test.js', tier: 'full' },  // 11.5s
  { file: 'test/sources.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/pr-groups.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/tier-a-view.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/tree-grouping.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/tree-characterization.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/cards-view-model.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/cards-wiring.test.js', tier: 'full' },  // 7s
  { file: 'test/tree-grouping-rules.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/tree-row-models.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/empty-states-and-limits.test.js', tier: 'full' },  // 8.0s
  { file: 'test/path-tree.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/folder-tree.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/review-tree-model.test.js', tier: 'quick' },  // 0.5s
  { file: 'test/feedback-file.test.js', tier: 'quick' },  // 0.3s
  { file: 'test/vocabulary.test.js', tier: 'quick' },  // 0.3s
  { file: 'test/review-tree-view.test.js', tier: 'quick' },  // 0.5s
  { file: 'test/tree-cleanup.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/review-updates.test.js', tier: 'full' },  // 7.3s
  { file: 'test/review-navigation.test.js', tier: 'full' },  // 9.3s
  { file: 'test/detail-panel-html.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/detail-panel.test.js', tier: 'full' },  // 17.6s
  { file: 'test/review-lens.test.js', tier: 'full' },  // 13.5s
  { file: 'test/caller-comment.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/pr-review-data.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/pr-review-store.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/pr-overview-html.test.js', tier: 'quick' },  // 0.4s
  { file: 'test/markdown-html.test.js', tier: 'quick' },  // 0.3s
  { file: 'test/pr-overview-panel.test.js', tier: 'full' },  // 5.7s
  { file: 'test/diff-lines.test.js', tier: 'quick' },  // 0.8s
  { file: 'test/review-comments.test.js', tier: 'quick' },  // 1.2s
  { file: 'test/suggestions.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/feedback-drafts.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/feedback-comments.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/feedback-tree.test.js', tier: 'quick' },  // 4.5s
  { file: 'test/review-threads.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/review-threads-details.test.js', tier: 'quick' },  // 2.3s
  { file: 'test/viewed-sync.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/outside-functions.test.js', tier: 'full' },  // 20.3s
  { file: 'test/test-reach.test.js', tier: 'full' },  // 11.2s
  { file: 'test/test-reach-view.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/syntactic-index.test.js', tier: 'quick' },  // 1.3s
  { file: 'test/inheritance.test.js', tier: 'quick' },  // 0.9s
  { file: 'test/tier-a.test.js', tier: 'quick' },  // 0.5s
  { file: 'test/preview-retention.test.js', tier: 'quick' },  // 0.5s
  { file: 'test/languages.test.js', heapMb: 8192, tier: 'quick' },  // 0.4s
  { file: 'test/textpos.test.js', heapMb: 8192, tier: 'quick' },  // 0.5s
  { file: 'test/callsites.test.js', heapMb: 8192, tier: 'quick' },  // 2.1s
  { file: 'test/run-fixtures.js', heapMb: 8192, tier: 'quick' },  // 0.4s
  { file: 'test/tree-smoke.js', heapMb: 8192, tier: 'quick' },  // 2.6s
  { file: 'test/storage-cleanup.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/agent-handoff.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/feedback-round-model.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/feedback-readback.test.js', tier: 'quick' },  // 2.5s
  { file: 'test/feedback-send.test.js', tier: 'quick' },  // 1.7s
  { file: 'test/storage-cleanup-run.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/feedback-round-view.test.js', tier: 'quick' },  // 2.4s
  { file: 'test/snapshot-store.test.js', tier: 'full' },  // 11.4s
  { file: 'test/fake-clock.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/no-wall-clock-rule.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/entry-points.test.js', tier: 'quick' },  // 0.1s
  { file: 'test/impact-paths.test.js', tier: 'quick' },  // 0.2s
  { file: 'test/impact-paths-preview.test.js', tier: 'quick' },  // 0.3s
  { file: 'test/clusters.test.js', tier: 'quick' },
  { file: 'test/cluster-hints.test.js', tier: 'quick' },
  { file: 'test/cards-facts.test.js', tier: 'quick' },
  { file: 'test/cards-remote.test.js', tier: 'quick' },
  { file: 'test/github-commits.test.js', tier: 'quick' },
  { file: 'test/repeated-edits.test.js', tier: 'quick' },
];

/**
 * Files in test/ that are deliberately not suite entries, with the reason. Each name is relative to test/.
 * @type {Record<string, string>}
 */
const EXCLUDED = {
  'review-findings-smoke.test.js': 'run by `npm run test:smoke` (the CI smoke stage)',
  'review-preview-smoke.test.js': 'run by `npm run test:smoke` (the CI smoke stage)',
  'bug-regressions-helpers.js': 'helper module required by tests',
  'java-syntactic-fixture.js': 'fixture module required by java-syntactic.test.js',
  'extension-env.js': 'helper module: the extension loaded against a throwaway repository',
  'find-typescript.js': 'helper module: locates the typescript module for tests',
  'fixture-repo.js': 'helper module: builds the synthetic fixture repository',
  'local-repo.js': 'helper module: throwaway git repositories',
  'target-repo.js': 'helper module: picks the fixture or IMPACT_TREE_TARGET_REPO',
  'fake-clock.js': 'helper module: a clock that moves only when a test moves it',
  'vscode-stub.js': 'helper module: stub of the vscode API',
  'webview-page.js': 'helper module: DOM boundary for the Details webview script',
  'windows-inheritance.js': 'child script spawned by test/inheritance.test.js',
  'windows-preview.js': 'child script spawned by test/remote-regressions.test.js',
  'windows-workspace-projects.js': 'child script spawned by test/local-programs.test.js',
  'go-signature-oracle.js': 'dev script: compares against the Go toolchain on a Go repo given as an argument',
  'py-signature-oracle.js': 'dev script: compares against Python\'s ast module on a Python repo given as an argument',
  'java-signature-oracle.js': 'dev script: compares against the JDK\'s Tree API (java-signature-oracle/Oracle.java) on a Java repo given as an argument',
  'lsp-harness/cards-verify.js': 'dev script: invariants and reference compare of cards over a corpus of real PRs; needs the repositories and recorded analysis results',
  'lsp-harness/py-verify.js': 'dev script: P7 verification against httpx, Pyright, ast and Jedi; needs the clone, a worktree and the scratchpad tools',
  'measure-cqrs-cache.js': 'dev script: measurement, not a pass/fail test',
  'measure-inheritance.js': 'dev script: measurement, not a pass/fail test',
  'record-fixture.js': 'dev script: `npm run record` captures fixtures',
  't3-pr-snapshots.js': '`npm run test:snapshots`: needs a clone of pingdotgg/t3code via IMPACT_TREE_TARGET_REPO',
  'run.js': 'this runner',
  'suite.js': 'this manifest',
};

/**
 * Compares the top-level *.js files of test/ with the manifest and the exclusion list.
 * @param {string} testDir absolute path of test/
 * @returns {string[]} problems; empty when every file is accounted for exactly once
 */
function checkCoverage(testDir) {
  const problems = [];
  const listed = new Map();
  for (const entry of SUITE) {
    if (listed.has(entry.file)) problems.push(`${entry.file} is listed twice in SUITE`);
    listed.set(entry.file, entry);
    if (entry.tier !== 'quick' && entry.tier !== 'full') problems.push(`${entry.file} has tier ${JSON.stringify(entry.tier)}`);
    if (!fs.existsSync(path.join(testDir, '..', entry.file))) problems.push(`${entry.file} is listed in SUITE but does not exist`);
  }
  const onDisk = fs.readdirSync(testDir).filter((name) => name.endsWith('.js') && fs.statSync(path.join(testDir, name)).isFile());
  for (const name of onDisk) {
    const inSuite = listed.has(`test/${name}`);
    const excluded = Object.prototype.hasOwnProperty.call(EXCLUDED, name);
    if (!inSuite && !excluded) problems.push(`test/${name} is in neither SUITE nor EXCLUDED: add it to test/suite.js`);
    if (inSuite && excluded) problems.push(`test/${name} is in both SUITE and EXCLUDED`);
  }
  for (const name of Object.keys(EXCLUDED)) {
    // A name in a subdirectory (a dev script under lsp-harness/) is not a suite candidate; it only has to exist.
    const exists = name.includes('/') ? fs.existsSync(path.join(testDir, name)) : onDisk.includes(name);
    if (!exists) problems.push(`EXCLUDED lists test/${name}, which does not exist`);
  }
  return problems;
}

module.exports = { SUITE, EXCLUDED, checkCoverage };
