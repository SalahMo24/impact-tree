'use strict';
// The GitHub star prompt: counted per distinct review, asked after the second, again 5 later if closed unanswered.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStarPrompt, afterReview, afterDismissed, readState, STATE_KEY, REPO_URL } = require('../src/session/star-prompt');

function fakeVscode(answer) {
  const seen = { asked: [], opened: [] };
  const vscode = {
    window: { showInformationMessage: async (m, ...items) => { seen.asked.push({ m, items }); return answer; } },
    env: { openExternal: async (uri) => { seen.opened.push(uri); return true; } },
    Uri: { parse: (s) => s },
  };
  return { vscode, seen };
}
const memento = () => { const values = new Map(); return { values, get: (k) => values.get(k), update: async (k, v) => { values.set(k, v); } }; };
const settle = () => new Promise((r) => setImmediate(r));

test('afterReview asks on the second distinct review only', () => {
  let { state, ask } = afterReview(readState(undefined), 'a');
  assert.equal(ask, false);
  ({ state, ask } = afterReview(state, 'a'));        // the same review again
  assert.equal(ask, false);
  ({ state, ask } = afterReview(state, 'b'));
  assert.equal(ask, true);
  assert.deepEqual(state, { reviews: ['b'], asked: true, need: 2 });
  ({ ask } = afterReview(state, 'c'));
  assert.equal(ask, false);
});

test('readState tolerates junk', () => {
  assert.deepEqual(readState('x'), { reviews: [], asked: false, need: 2 });
  assert.deepEqual(readState({ reviews: [1, 'k'], asked: 'yes', need: -1 }), { reviews: ['k'], asked: false, need: 2 });
});

test('the prompt opens the repository when the user picks the star', async () => {
  const { vscode, seen } = fakeVscode('Star on GitHub');
  const globalState = memento();
  const events = [];
  const prompt = createStarPrompt(vscode, { globalState, telemetry: { event: (n, p) => events.push([n, p]) } });
  prompt.reviewFinished('local:main');
  await settle();
  prompt.reviewFinished('local:main');
  await settle();
  assert.equal(seen.asked.length, 0);
  prompt.reviewFinished('pr:7');
  await settle();
  assert.equal(seen.asked.length, 1);
  assert.deepEqual(seen.opened, [REPO_URL]);
  assert.deepEqual(events, [['starPrompt.answered', { answer: 'star' }]]);
  prompt.reviewFinished('pr:8');
  await settle();
  assert.equal(seen.asked.length, 1, 'asked once per install');
  assert.equal(globalState.values.get(STATE_KEY).asked, true);
});

test('afterDismissed waits for 5 more distinct reviews, not counting the one that asked', () => {
  let state = afterDismissed({ reviews: ['b'], asked: true, need: 2 });
  let ask;
  ({ state, ask } = afterReview(state, 'b'));
  assert.equal(ask, false);
  for (const k of ['c', 'd', 'e', 'f']) { ({ state, ask } = afterReview(state, k)); assert.equal(ask, false); }
  ({ ask } = afterReview(state, 'g'));
  assert.equal(ask, true);
});

test('a dismissed prompt opens nothing and asks again after 5 more reviews', async () => {
  const { vscode, seen } = fakeVscode(undefined);
  const prompt = createStarPrompt(vscode, { globalState: memento() });
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) { prompt.reviewFinished(k); await settle(); }
  assert.equal(seen.asked.length, 1);
  prompt.reviewFinished('g');
  await settle();
  assert.equal(seen.asked.length, 2);
  assert.equal(seen.opened.length, 0);
});

test('"No thanks" is final', async () => {
  const { vscode, seen } = fakeVscode('No thanks');
  const prompt = createStarPrompt(vscode, { globalState: memento() });
  for (let i = 0; i < 12; i++) { prompt.reviewFinished(`k${i}`); await settle(); }
  assert.equal(seen.asked.length, 1);
  assert.equal(seen.opened.length, 0);
});

test('without global state nothing is asked', async () => {
  const { vscode, seen } = fakeVscode('Star on GitHub');
  const prompt = createStarPrompt(vscode, { globalState: undefined });
  for (const k of ['a', 'b', 'c']) { prompt.reviewFinished(k); await settle(); }
  assert.equal(seen.asked.length, 0);
});
