'use strict';
// What a row of the review tree offers in its menus (package.json). A finding is the thing to
// look at, so a row carries at most one inline action; the review's own row (`reviewHost`)
// holds the review's controls and is the one place with several (L3, "findings foreground,
// mechanics background").
const test = require('node:test');
const assert = require('node:assert/strict');
const { contributes } = require('../package.json');

const items = contributes.menus['view/item/context'];
const inline = (m) => String(m.group).startsWith('inline');

// A row kind named by a `when` clause: `viewItem == x`, or `viewItem =~ /^(a|b)$/`. A clause that
// names none (a view-wide entry) belongs to no row kind.
const kindsOf = (when) => {
  const exact = [...when.matchAll(/viewItem == (\w+)/g)].map((m) => m[1]);
  const pattern = [...when.matchAll(/viewItem =~ \/([^/]+)\//g)].map((m) => m[1]);
  return [...exact, ...pattern];
};

// Row kinds allowed more than one inline action, each with the reason.
const EXCEPTIONS = new Map([
  // A draft is read and then either edited or thrown away: both are the point of the row.
  ['feedbackDraft', 2],
]);

test('every row kind but the review\'s own row has at most one inline action', () => {
  /** @type {Map<string, string[]>} */
  const byKind = new Map();
  for (const m of items.filter(inline)) {
    for (const kind of kindsOf(m.when)) {
      if (kind === 'reviewHost') continue;
      byKind.set(kind, [...(byKind.get(kind) || []), m.command]);
    }
  }
  assert.ok(byKind.size >= 3, `the check must see the row kinds that have an inline action: ${[...byKind.keys()]}`);
  for (const [kind, commands] of byKind) {
    assert.ok(commands.length <= (EXCEPTIONS.get(kind) ?? 1), `${kind} has ${commands.length} inline actions: ${commands}`);
  }
  // the two that matter: Show callers on a finding, Retry on a failed viewed sync
  assert.deepEqual(byKind.get('finding'), ['impactTree.showCallers']);
  assert.deepEqual(byKind.get('ViewedFailed$'), ['impactTree.retryViewedSync']);
});

test('finding the tests is on the review\'s row, inline and in its menu, until the tests were searched', () => {
  const entries = items.filter((m) => m.command === 'impactTree.computeTestReach');
  assert.deepEqual(entries.map((m) => m.group).sort(), ['1_mode@3', 'inline@7']);
  for (const m of entries) {
    assert.deepEqual(kindsOf(m.when), ['reviewHost']);
    assert.match(m.when, /impactTree\.state == shown/);
    assert.match(m.when, /!impactTree\.testReachComputed/);
  }
  const command = contributes.commands.find((c) => c.command === 'impactTree.computeTestReach');
  assert.equal(command.title, 'Impact Tree: Find the tests that cover this review');
  assert.equal(command.icon, '$(beaker)');
});

const { localResult, finding, withEnv } = require('./extension-env');
const path = require('path');

test('the context key for "find the tests" is false with no result and until the walk ran, then true', () => withEnv(async (env) => {
  const key = 'impactTree.testReachComputed';
  assert.equal(env.seen.contexts[key], false, 'no result');
  env.hooks.localResult = (o) => localResult(o, { findings: [finding('target', path.join(env.dir, 'a.ts'), 5)] });
  await env.refresh();
  assert.equal(env.seen.contexts[key], false, 'a review is shown, its tests were not searched');
  await env.computeTestReach();
  assert.equal(env.seen.contexts[key], true, 'searched: the command goes away');
}));
