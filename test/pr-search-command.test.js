'use strict';
// The "Search pull requests" command against a stub picker: picking a PR opens it, a
// number that is not loaded is looked up on GitHub, and a list that loads while the
// picker is open shows up in it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { registerPullRequestSearch } = require('../src/session/pr-search-command');

function setup({ prs = [], getPullRequest = async () => null, signedIn = true, slug = { owner: 'o', repo: 'r' } } = {}) {
  const executed = [];
  const warnings = [];
  let picker = null;
  const listeners = new Set();
  const handlers = {};
  const commands = {};
  const store = new Map();
  const vscode = {
    QuickPickItemKind: { Separator: -1 },
    commands: {
      registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (...args) => { executed.push(args); },
    },
    window: {
      showWarningMessage: (m) => { warnings.push(m); },
      showInformationMessage: async () => undefined,
      createQuickPick: () => {
        const on = (name) => (fn) => { handlers[name] = fn; return { dispose() {} }; };
        picker = { items: [], selectedItems: [], value: '', shown: false, hidden: false,
          onDidChangeValue: on('value'), onDidAccept: on('accept'), onDidHide: on('hide'),
          show() { this.shown = true; }, hide() { this.hidden = true; handlers.hide(); }, dispose() {} };
        return picker;
      },
    },
  };
  let list = prs;
  const search = registerPullRequestSearch(vscode, {
    gh: { isSignedIn: () => signedIn, account: () => 'me', getPullRequest },
    repoSlug: () => slug,
    getPrs: () => list, getPrsTruncated: () => false, isLoadingPrs: () => false,
    getTeams: () => ({ teams: [], error: null }),
    onDidChangePrs: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    workspaceState: { get: (k) => store.get(k), update: async (k, v) => { store.set(k, v); } },
    log: () => {},
  });
  return {
    run: () => commands['impactTree.searchPullRequests'](),
    picker: () => picker,
    type: (v) => { picker.value = v; handlers.value(v); },
    accept: async (item) => { picker.selectedItems = [item]; await handlers.accept(); },
    setPrs: (next) => { list = next; for (const fn of listeners) fn(); },
    listeners, executed, warnings, search,
  };
}

const pr = (number, title = `PR ${number}`) => ({ number, title, author: 'a', requestedReviewers: [], requestedTeams: [] });
const prItems = (items) => items.filter((i) => i.pr).map((i) => i.pr.number);

test('picking a PR opens it through the usual open-PR flow', async () => {
  const env = setup({ prs: [pr(1), pr(2)] });
  await env.run();
  assert.ok(env.picker().shown);
  assert.ok(env.picker().matchOnDescription, 'authors are searchable');
  assert.deepEqual(prItems(env.picker().items), [1, 2]);
  await env.accept(env.picker().items.find((i) => i.pr && i.pr.number === 2));
  assert.deepEqual(env.executed, [['impactTree.openPullRequest', env.picker().items.find((i) => i.pr && i.pr.number === 2).pr]]);
  assert.ok(env.picker().hidden);
  assert.equal(env.listeners.size, 0, 'the picker stops listening once closed');
});

test('a number that is not loaded is offered as a lookup, and found PRs open', async () => {
  const found = { ...pr(900, 'old one'), state: 'merged' };
  const asked = [];
  const env = setup({ prs: [pr(1)], getPullRequest: async (slug, n) => { asked.push([slug.repo, n]); return found; } });
  await env.run();
  env.type('1');
  assert.ok(!env.picker().items[0].lookup, 'no lookup for a loaded PR');
  env.type('#900');
  const [lookup] = env.picker().items;
  assert.equal(lookup.lookup, 900);
  assert.ok(lookup.alwaysShow, 'the picker\'s own filter must not hide it');
  await env.accept(lookup);
  assert.deepEqual(asked, [['r', 900]]);
  assert.deepEqual(env.executed, [['impactTree.openPullRequest', found]]);
});

test('a lookup GitHub answers 404 for says so and keeps the picker open', async () => {
  const env = setup({ getPullRequest: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } });
  await env.run();
  env.type('77');
  await env.accept(env.picker().items[0]);
  assert.deepEqual(env.executed, []);
  assert.match(env.warnings[0], /no pull request #77/);
  assert.ok(!env.picker().hidden);
  assert.equal(env.picker().enabled, true);
});

test('a PR list that finishes loading after the picker opened shows up in it', async () => {
  const env = setup({ prs: [] });
  await env.run();
  assert.deepEqual(prItems(env.picker().items), []);
  env.setPrs([pr(5)]);
  assert.deepEqual(prItems(env.picker().items), [5]);
});

test('a title with $(…) is not rendered as an icon', async () => {
  const env = setup({ prs: [pr(3, 'Use $(pwd) in script')] });
  await env.run();
  const item = env.picker().items.find((i) => i.pr);
  assert.ok(!item.label.includes('$('), item.label);
});

test('without a GitHub remote nothing opens', async () => {
  const env = setup({ slug: null });
  await env.run();
  assert.equal(env.picker(), null);
  assert.match(env.warnings[0], /no GitHub remote/);
});
