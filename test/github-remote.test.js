'use strict';
// Which git remote is the GitHub repository: parsing `git remote -v`, the automatic choice,
// the setting, and the sentence shown when there is no choice (src/github-remote.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRemoteList, chooseGitHubRemote, isSafeRemoteName, describeRemoteProblem } = require('../src/github-remote');

const remote = (name, url) => ({ name, url });
const GH = (owner, repo = 'repo') => `https://github.com/${owner}/${repo}.git`;

test('parseRemoteList reads real `git remote -v` output: ssh and https, push lines, duplicates', () => {
  const text = [
    'origin\tgit@github.com:me/repo.git (fetch)',
    'origin\tgit@github.com:me/repo.git (push)',
    'upstream\thttps://github.com/org/repo.git (fetch)',
    'upstream\thttps://github.com/org/repo.git (push)',
    'upstream\thttps://github.com/org/other.git (fetch)',
    'mirror\thttps://gitlab.com/org/repo.git (fetch)',
    'not a remote line',
    '',
  ].join('\n');
  assert.deepEqual(parseRemoteList(text), [
    remote('origin', 'git@github.com:me/repo.git'),
    remote('upstream', 'https://github.com/org/repo.git'),
    remote('mirror', 'https://gitlab.com/org/repo.git'),
  ]);
  assert.deepEqual(parseRemoteList(''), []);
  assert.deepEqual(parseRemoteList(undefined), []);
});

test('chooseGitHubRemote: origin only', () => {
  assert.deepEqual(chooseGitHubRemote([remote('origin', GH('me'))], ''),
    { kind: 'ok', name: 'origin', owner: 'me', repo: 'repo' });
});

test('chooseGitHubRemote: upstream and origin (a fork setup) gives upstream', () => {
  assert.deepEqual(chooseGitHubRemote([remote('origin', GH('me')), remote('upstream', GH('org'))], ''),
    { kind: 'ok', name: 'upstream', owner: 'org', repo: 'repo' });
});

test('chooseGitHubRemote: a single GitHub remote not named origin is the one', () => {
  assert.deepEqual(chooseGitHubRemote([remote('work', 'git@github.com:org/repo.git')], undefined),
    { kind: 'ok', name: 'work', owner: 'org', repo: 'repo' });
});

test('chooseGitHubRemote: GitHub and GitLab remotes give the GitHub one', () => {
  assert.deepEqual(chooseGitHubRemote([remote('origin', 'https://gitlab.com/o/r.git'), remote('gh', GH('org'))], ''),
    { kind: 'ok', name: 'gh', owner: 'org', repo: 'repo' });
});

test('chooseGitHubRemote: several GitHub remotes, none upstream or origin, are ambiguous', () => {
  assert.deepEqual(chooseGitHubRemote([remote('a', GH('x')), remote('b', GH('y')), remote('c', 'https://gitlab.com/o/r.git')], ''),
    { kind: 'ambiguous', names: ['a', 'b'] });
});

test('chooseGitHubRemote: none on github.com, or no remotes at all', () => {
  assert.deepEqual(chooseGitHubRemote([remote('origin', 'https://gitlab.com/o/r.git')], ''), { kind: 'none' });
  assert.deepEqual(chooseGitHubRemote([], ''), { kind: 'none' });
});

test('chooseGitHubRemote: the setting picks a remote over the automatic rule', () => {
  const remotes = [remote('origin', GH('me')), remote('upstream', GH('org'))];
  assert.deepEqual(chooseGitHubRemote(remotes, 'origin'), { kind: 'ok', name: 'origin', owner: 'me', repo: 'repo' });
});

test('chooseGitHubRemote: a setting that is missing, not GitHub or unsafe is a bad setting, never the automatic choice', () => {
  const remotes = [remote('origin', GH('me')), remote('lab', 'https://gitlab.com/o/r.git')];
  assert.deepEqual(chooseGitHubRemote(remotes, 'nope'), { kind: 'bad-setting', setting: 'nope', reason: 'missing' });
  assert.deepEqual(chooseGitHubRemote(remotes, 'lab'), { kind: 'bad-setting', setting: 'lab', reason: 'not-github' });
  assert.deepEqual(chooseGitHubRemote(remotes, '--upload-pack=x'), { kind: 'bad-setting', setting: '--upload-pack=x', reason: 'unsafe' });
  assert.deepEqual(chooseGitHubRemote(remotes, 42), { kind: 'bad-setting', setting: '42', reason: 'unsafe' });
});

test('chooseGitHubRemote: a remote with an unsafe name is never chosen automatically', () => {
  assert.deepEqual(chooseGitHubRemote([remote('-x', GH('me'))], ''), { kind: 'none' });
});

test('isSafeRemoteName', () => {
  for (const bad of ['-x', 'a b', '', '.hidden', 'a/b', undefined, 3]) assert.equal(isSafeRemoteName(bad), false, String(bad));
  for (const good of ['upstream', 'my.fork-2', 'origin', 'a_b']) assert.equal(isSafeRemoteName(good), true, good);
});

test('describeRemoteProblem says what is wrong in one sentence, and nothing when it is fine', () => {
  assert.equal(describeRemoteProblem({ kind: 'ok', name: 'origin', owner: 'o', repo: 'r' }), null);
  assert.equal(describeRemoteProblem({ kind: 'none' }), 'No remote of this repository points at github.com.');
  assert.equal(describeRemoteProblem({ kind: 'ambiguous', names: ['a', 'b'] }),
    'Several remotes point at github.com (a, b); set impactTree.githubRemote to the one pull requests are opened against.');
  assert.match(describeRemoteProblem({ kind: 'bad-setting', setting: 'x', reason: 'missing' }), /'x', which is not a remote of this repository/);
  assert.match(describeRemoteProblem({ kind: 'bad-setting', setting: 'x', reason: 'not-github' }), /'x', which does not point at github.com/);
  assert.match(describeRemoteProblem({ kind: 'bad-setting', setting: '-x', reason: 'unsafe' }), /not a valid remote name/);
});
