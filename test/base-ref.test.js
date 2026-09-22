#!/usr/bin/env node
'use strict';
// Base resolution against a throwaway repo built for the purpose, so the assertions
// do not depend on whatever the target repo's history happens to look like.
//
// Two rules pull in opposite directions and both matter:
//   a BRANCH must resolve to origin/<branch> -- a stale local main turned a 37-file
//   PR into a 130-file one;
//   a REVISION EXPRESSION must resolve to itself -- `HEAD~40` silently became
//   `origin/HEAD~40`, which resolves because origin/HEAD is the remote default
//   branch, and produced an empty diff that read as "nothing changed".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeGit, resolveBase } = require('../src/engine/git');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'it-baseref-'));
const origin = path.join(tmp, 'origin');
const clone = path.join(tmp, 'clone');
const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

fs.mkdirSync(origin, { recursive: true });
run(origin, ['init', '--quiet', '--initial-branch=main']);
run(origin, ['config', 'user.email', 't@example.com']);
run(origin, ['config', 'user.name', 'test']);
for (let i = 0; i < 6; i++) {
  fs.writeFileSync(path.join(origin, `f${i}.txt`), `v${i}\n`);
  run(origin, ['add', '.']);
  run(origin, ['commit', '--quiet', '-m', `c${i}`]);
}
run(tmp, ['clone', '--quiet', origin, clone]);
run(clone, ['config', 'user.email', 't@example.com']);
run(clone, ['config', 'user.name', 'test']);
// move origin ahead so local main is genuinely stale
fs.writeFileSync(path.join(origin, 'ahead.txt'), 'x\n');
run(origin, ['add', '.']);
run(origin, ['commit', '--quiet', '-m', 'ahead']);
run(clone, ['fetch', '--quiet', 'origin']);

const git = makeGit(clone);
const headSha = git.revParse('HEAD');
const head3 = git.revParse('HEAD~3');

console.log('▸ revision expressions resolve to themselves');
for (const spec of ['HEAD~3', 'HEAD', head3.slice(0, 8), head3]) {
  const r = resolveBase(git, spec, { allowLocal: true });
  const want = spec === 'HEAD' ? headSha : head3;
  check(`${spec.slice(0, 12).padEnd(12)} -> ${r.ref.slice(0, 12)}`, r.sha === want, `${r.sha.slice(0, 8)} vs ${want.slice(0, 8)}`);
}
{
  const r = resolveBase(git, 'HEAD~3', { allowLocal: true });
  check('and it is NOT rewritten to origin/…', !r.ref.startsWith('origin/'), r.ref);
}

console.log('\n▸ branch names still prefer the remote');
{
  const r = resolveBase(git, 'main', { allowLocal: true });
  check('main resolves to origin/main', r.ref === 'origin/main', r.ref);
  check('and says the local branch is behind',
    r.notes.some((n) => /behind/.test(n)), r.notes.join('; '));
  check('the sha is the remote tip, not the local one',
    r.sha === git.revParse('origin/main') && r.sha !== git.revParse('main'));
}
{
  const r = resolveBase(git, 'origin/main', { allowLocal: true });
  check('an explicit origin/ ref is left alone', r.ref === 'origin/main', r.ref);
}

console.log('\n▸ unresolvable input fails loudly');
{
  let threw = null;
  try { resolveBase(git, 'HEAD~9999', { allowLocal: true }); } catch (e) { threw = e.message; }
  check('a revision that cannot be resolved throws rather than returning a wrong base',
    !!threw && /cannot resolve base revision/.test(threw), String(threw));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failure(s)` : '\nall base-ref checks passed');
process.exit(fail ? 1 : 0);
