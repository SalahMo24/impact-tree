// @ts-check
'use strict';

// "Analyse with my agent" (impactTree.analyseWithAgent): asks the user's own coding agent to
// refine the Cards view's cards. This module only hands a prompt over; the user confirms and
// starts the run in their agent (docs/AI_PLAN.md, AI-D1). What the agent saves comes back
// through the bridge (src/agent-bridge.js) and is shown by the Cards view.
//
// Ownership: the in-memory state (waiting, head, toggle) belongs to `state`; the stored
// results belong to the bridge. Nothing here runs unless the command is called.

const { buildCardsPrompt } = require('./agent-prompt');
const { handOff } = require('./agent-handoff');
const { realClock } = require('./engine/clock');

/**
 * @param {any} vscode
 * @param {{ session: any, bridge: { context: () => Promise<any>, removeResult: (head: string, key: string) => Promise<boolean> },
 *   state: ReturnType<typeof import('./agent-cards-state').createAgentCardsState>,
 *   chooseAgent: (vscode: any, forceAsk: boolean, opts: { title: string, exclude: string[] }) => Promise<{ id: import('./agent-handoff').AgentChoiceId, label: string }|null>,
 *   log: (m: string) => void, redraw: () => void, clock?: import('./engine/clock').Clock }} deps
 *   `redraw`: refresh the Cards view.
 */
function createAnalyseWithAgent(vscode, { session, bridge, state, chooseAgent, log, redraw, clock = realClock }) {
  // Only one hand-off at a time: the picker and the hand-off can take a while.
  let running = false;

  /** @param {string} message */
  const say = (message) => { void vscode.window.showInformationMessage(`Impact Tree: ${message}`); };

  /** @returns {string|null} Why there is nothing to hand over yet, or null. */
  function missing() {
    const s = session.state || {};
    if ((s.source && s.source.kind === 'pr') || (s.result && s.result.tierA)) {
      return 'the agent tools do not support a pull request preview yet. Check the pull request out, then run this again.';
    }
    if (!s.result) return 'there is no finished analysis yet. Review a checked-out branch or pull request first.';
    if (!s.cards || !(s.cards.clusters || []).length) {
      return s.cardsError ? `there are no cards to refine (${s.cardsError}).` : 'there are no cards to refine yet. Wait for the analysis to finish; cards appear for reviews with 4 or more changes.';
    }
    return null;
  }

  async function run() {
    if (running) { say('an agent hand-off is already in progress.'); return; }
    running = true;
    try {
      const why = missing();
      if (why) { say(why); return; }
      const ctx = await bridge.context();
      if (!ctx) { say('there is no finished review of a checked-out branch to hand over (a preview or an analysis still running does not count).'); return; }
      const choice = await chooseAgent(vscode, false, { title: 'Impact Tree: Analyse with…', exclude: ['save'] });
      if (!choice) return;
      let sentence;
      try {
        sentence = await handOff(vscode, choice.id, { prompt: buildCardsPrompt(ctx), repoRoot: ctx.repo });
      } catch (e) {
        log(`agent: hand-off to ${choice.id} failed: ${e && /** @type {any} */ (e).message}`);
        void vscode.window.showErrorMessage(`Impact Tree: it could not be sent to ${choice.label} (${e && /** @type {any} */ (e).message}).`);
        return;
      }
      log(`agent: asked ${choice.id} to refine the cards`);
      if (state.asked(ctx.head, clock.now())) redraw();
      say(sentence);
    } finally {
      running = false;
    }
  }

  return {
    run,
    cancelWaiting() { if (state.cancel()) redraw(); },
    toggle() { if (state.toggle()) redraw(); },
    /** @param {unknown} key @returns {Promise<void>} */
    async undo(key) {
      const head = state.head;
      if (!head || typeof key !== 'string') return;
      try {
        await bridge.removeResult(head, key);
      } catch (e) {
        log(`agent: could not remove the result: ${e && /** @type {any} */ (e).message}`);
        void vscode.window.showErrorMessage('Impact Tree: the agent result could not be removed.');
      }
      redraw();
    },
  };
}

module.exports = { createAnalyseWithAgent };
