'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), { execFileSync } = require('child_process');
// External checks use pinned real PR snapshots, independent of synthetic fixtures.
// Requires an existing T3 Code clone with these commits and installed dependencies.
const home = path.resolve(__dirname, '..'), source = require('./target-repo')();
const repo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'impact-t3-prs-'));
let missing = 0;
const { analyze } = require(home + '/src/engine/analyze'), { analyzeRemote } = require(home + '/src/engine/analyze-remote'), { makeGit } = require(home + '/src/engine/git'), { changedFiles } = require(home + '/src/engine/diff');
const ts = require(home + '/node_modules/typescript');
const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
(async () => {
    try {
        execFileSync('git', ['clone', '--shared', '--no-checkout', source, repo], { stdio: 'pipe' });
        for (const [number, commit] of [[12745, 'e1cbb705'], [12954, '742173a1']]) {
            run('checkout', '--detach', commit);
            for (const parent of ['', 'apps', 'packages']) {
                const dirs = parent ? fs.readdirSync(path.join(source, parent), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => path.join(parent, x.name)) : [''];
                for (const d of dirs) {
                    const dest = path.join(repo, d, 'node_modules'), src = path.join(source, d, 'node_modules');
                    if (fs.existsSync(src) && fs.existsSync(path.dirname(dest)) && !fs.existsSync(dest))
                        fs.symlinkSync(src, dest);
                }
            }
            const git = makeGit(repo), base = run('rev-parse', 'HEAD^').trim(), head = run('rev-parse', 'HEAD').trim();
            const local = await analyze(repo, { mode: 'checkpoint', checkpoint: base, skipForest: true, deferTestReach: true });
            const files = changedFiles(git, base, 'HEAD', null).map(f => ({ ...f, patch: run('diff', '--no-ext-diff', '--unified=3', base, 'HEAD', '--', ...(f.oldPath ? [f.oldPath] : []), f.path) }));
            const remote = await analyzeRemote({ ts, repoRoot: repo, slug: 'pingdotgg/t3code', pr: { number, headSha: head, baseSha: base, mergeBaseSha: base, baseRef: 'main', changedFiles: files.length }, gh: { listPullRequestFiles: async () => ({ files, total: files.length }), fileAtRef: async (_, p, ref) => git.show(ref, p) } });
            for (const [name, r] of [['local', local], ['preview', remote]]) {
                const find = label => r.allChanged.find(s => s.label === label);
                if (number === 12745) {
                    assert(find('resolveWeekStartsOn')?.added);
                    assert(find('CustomSnoozeDialog'));
                    assert(!find('resolveWeekStartsOn').callers.some(c => c.label === 'CustomSnoozeDialog'));
                }
                else {
                    const target = find('resolveProjectSettings');
                    assert(target);
                    assert.deepEqual(target.kinds.map(k => k.id), ['optional-param']);
                    assert(find('hasProjectSettingsOverrides'));
                    for (const expected of ['resolveScopedSettingsTargets', 'planScopedSettingsPatch']) {
                        if (!target.callers.some(c => c.label.includes(expected))) {
                            missing++;
                            console.error('MISSING cross-project caller', name, expected);
                        }
                    }
                }
                console.log(JSON.stringify({ pr: number, pipeline: name, changed: r.allChanged.length, warnings: r.warnings, target: number === 12954 ? { kinds: find('resolveProjectSettings').kinds.map(k => k.id), callers: find('resolveProjectSettings').callers.map(c => ({ label: c.label, state: c.callState })) } : find('resolveWeekStartsOn').callers.map(c => c.label) }));
            }
        }
        console.log(`Scoped snapshot checks passed; ${missing} missing cross-project caller expectations.`);
        if (missing)
            process.exitCode = 1;
    }
    finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
