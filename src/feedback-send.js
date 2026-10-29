// @ts-check
'use strict';
const { realClock } = require('./engine/clock');
// "Send feedback" (docs/UX_PLAN.md F3): turns the drafts into a round file, takes the
// round's snapshot and makes it the checkpoint, hands the round to an agent, and offers
// once per repository to point AGENTS.md / CLAUDE.md at the feedback folder.
//
// Order matters for trust: the snapshot is taken first and the file is written second, so
// a failure leaves the drafts untouched and nothing half-sent (a snapshot whose file could
// not be written is removed again). Drafts are cleared only after both exist. The hand-off
// comes last: if the agent cannot be started, the round is still saved and the message
// says what did not happen.

const fs = require('fs');
const path = require('path');
const { renderRound, promptFor } = require('./feedback-file');
const { writeRound, listRounds } = require('./feedback-files-io');
const { nextRoundNumber } = require('./feedback-file');
const { choicesFor, handOff, onPath, isCursor, CHAT_COMMAND, CLAUDE_EXTENSION_ID } = require('./agent-handoff');
const { withPointer, targetsFor } = require('./agent-pointer');
const { readSentRounds, withSentRound, summaryOf, ROUNDS_KEY } = require('./feedback-round-model');
const { modeLabel } = require('./engine/mode-labels');

const POINTER_KEY = 'impactTree.agentPointer';

/** @param {unknown} e */
const errorText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @typedef {{ id: string, file: string, line: number|null, symbol: string|null,
 *   caller: { label: string, file: string, line: number }|null, quote: string,
 *   body: string, createdAtMs: number }} FeedbackItem
 * @typedef {{
 *   drafts: { list: () => FeedbackItem[], clear: () => Promise<void>|void },
 *   getSnapshotStore: () => any,
 *   session: any,
 *   workspaceState: { get: (k: string) => any, update: (k: string, v: any) => PromiseLike<void> },
 *   log: (m: string) => void,
 *   afterSend?: () => void,
 *   now?: () => number,
 * }} SendDeps
 * `now` dates the round, in epoch milliseconds; omitted: Date.now.
 */

/**
 * Creates the command handler. One send runs at a time; a second press while one is
 * running is refused with a message.
 * @param {any} vscode
 * @param {SendDeps} deps
 * @returns {(opts?: { ask?: boolean }) => Promise<void>}
 */
function createSendFeedback(vscode, deps) {
  let running = false;
  let pointerAskedThisSession = false;
  return async ({ ask = false } = {}) => {
    if (running) { vscode.window.showInformationMessage('Impact Tree: feedback is already being sent.'); return; }
    running = true;
    try {
      await send(vscode, deps, { ask, pointerAsked: () => pointerAskedThisSession, markPointerAsked: () => { pointerAskedThisSession = true; } });
    } finally {
      running = false;
    }
  };
}

/**
 * @param {any} vscode
 * @param {SendDeps} deps
 * @param {{ ask: boolean, pointerAsked: () => boolean, markPointerAsked: () => void }} o
 */
async function send(vscode, deps, o) {
  const { drafts, session, log, now = realClock.now } = deps;
  const items = drafts.list();
  if (!items.length) { vscode.window.showInformationMessage('Impact Tree: there is no feedback to send. Add feedback on a change first.'); return; }
  let repo;
  try { repo = session.repoRoot(); } catch { vscode.window.showWarningMessage('Impact Tree: open a repository folder to send feedback.'); return; }

  const choice = await chooseAgent(vscode, o.ask);
  if (!choice) return;

  const store = deps.getSnapshotStore();
  const result = session.state && session.state.result;
  const source = session.state && session.state.source;
  const reviewed = reviewedLabel(source, (result && result.mode) || vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'));
  const { makeGit } = require('./engine/git');
  const branch = makeGit(repo).tryRaw(['symbolic-ref', '--quiet', '--short', 'HEAD']);

  /** @type {{ round: number, relPath: string, absPath: string, checkpointSha: string|null }} */
  let sent;
  try {
    sent = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Saving feedback…' },
      () => saveRound({ repo, store, items, branch: branch ? branch.trim() : null, reviewed, now }));
  } catch (e) {
    log(`feedback: send failed: ${errorText(e)}`);
    vscode.window.showErrorMessage(`Impact Tree: the feedback was not sent (${errorText(e)}). Your drafts are kept.`);
    return;
  }

  // The round exists now: remember it, make its snapshot the checkpoint, clear the drafts.
  if (sent.checkpointSha) {
    const stored = readSentRounds(deps.workspaceState.get(ROUNDS_KEY)).rounds;
    await deps.workspaceState.update(ROUNDS_KEY, withSentRound(stored, {
      round: sent.round, relPath: sent.relPath, checkpointSha: sent.checkpointSha, sentAtMs: now(),
      items: items.map((i) => ({ id: i.id, file: i.file, line: i.line, symbol: i.symbol, summary: summaryOf(i.body) })),
    }));
    session.setCheckpoint(sent.checkpointSha);
    await deps.workspaceState.update('impactTree.checkpoint', sent.checkpointSha);
  }
  await drafts.clear();

  let handedOff;
  try {
    handedOff = await handOff(vscode, choice.id, { prompt: promptFor({ relPath: sent.relPath }), repoRoot: repo });
  } catch (e) {
    log(`feedback: hand-off to ${choice.id} failed: ${errorText(e)}`);
    handedOff = `It could not be sent to ${choice.label} (${errorText(e)}); the file is saved.`;
  }
  const checkpointText = sent.checkpointSha
    ? ' Checkpoint set, so the next review shows only what changed since.'
    : ' No checkpoint was recorded (this window has no storage folder), so the next review cannot show what changed since.';
  // Not awaited: the message stays up while the view switches; showSent handles its own errors.
  void showSent(vscode, `Feedback round ${sent.round} saved to ${sent.relPath}. ${handedOff}${checkpointText}`, sent.absPath, log);

  // A checked-out pull request is left too: the agent works on the same files on disk, and
  // what it changes is seen against the round's snapshot. Picking the pull request again
  // reviews it against its base.
  const shownNow = session.state && session.state.source;
  if (sent.checkpointSha && (!shownNow || shownNow.kind === 'local' || shownNow.kind === 'checkout')) {
    await vscode.workspace.getConfiguration('impactTree').update('mode', 'checkpoint', vscode.ConfigurationTarget.Workspace);
    await session.refresh('checkpoint');
  }
  if (deps.afterSend) deps.afterSend();
  await offerPointer(vscode, deps, repo, o);
}

/**
 * What the round file says was reviewed: the mode, or the pull request checked out.
 * @param {any} source The session's source.
 * @param {string} mode
 * @returns {string}
 */
function reviewedLabel(source, mode) {
  if (source && source.kind === 'checkout' && source.pr && Number.isSafeInteger(source.pr.number)) {
    return `Pull request #${source.pr.number} (checked out)`;
  }
  return modeLabel(mode);
}

/**
 * Snapshot, then file. A snapshot whose file could not be written is removed again.
 * @param {{ repo: string, store: any, items: FeedbackItem[], branch: string|null, reviewed: string, now?: () => number }} o
 *   `now` dates the round, in epoch milliseconds; omitted: Date.now.
 */
async function saveRound({ repo, store, items, branch, reviewed, now = realClock.now }) {
  const { files } = await listRounds(repo);
  const expected = nextRoundNumber(files.map((f) => f.name));
  const record = store ? await store.take({ round: expected }) : null;
  const sentAtMs = now();
  try {
    const written = await writeRound({
      repoRoot: repo, now: sentAtMs,
      render: (round) => renderRound({ round, sentAtMs, branch, modeLabel: reviewed, checkpointSha: record ? record.sha : null, items }),
    });
    return { ...written, checkpointSha: record ? record.sha : null };
  } catch (e) {
    if (record) await store.remove(record.id).catch(() => {});
    throw e;
  }
}

/**
 * The agent from the `impactTree.agent` setting, or the picker when it is `ask` or `ask`
 * is forced. A pick from the picker is remembered in the user's settings.
 * @param {any} vscode
 * @param {boolean} forceAsk
 * @param {{ title?: string, exclude?: string[] }} [opts] `title`: the picker's title. `exclude`: choices that make no
 *   sense for this caller (a saved setting naming one of them is ignored and the picker shows).
 * @returns {Promise<{ id: import('./agent-handoff').AgentChoiceId, label: string }|null>}
 */
async function chooseAgent(vscode, forceAsk, { title = 'Impact Tree: Send feedback to…', exclude = [] } = {}) {
  const cfg = vscode.workspace.getConfiguration('impactTree');
  const chatAvailable = (await vscode.commands.getCommands(true)).includes(CHAT_COMMAND);
  const choices = choicesFor({ cliFound: (exe) => onPath(exe, { pathEnv: process.env.PATH, platform: process.platform }), chatAvailable,
    claudeExtension: Boolean(vscode.extensions && vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)), inCursor: isCursor(vscode.env && vscode.env.appName) })
    .filter((c) => !exclude.includes(c.id));
  const saved = cfg.get('agent', 'ask');
  const preset = choices.find((c) => c.id === saved);
  if (!forceAsk && preset) return preset;
  const pick = await vscode.window.showQuickPick(
    choices.map((c) => ({ label: c.label, description: c.description, id: c.id })),
    { title, placeHolder: 'Remembered for next time; "Send feedback to…" asks again' });
  if (!pick) return null;
  await cfg.update('agent', pick.id, vscode.ConfigurationTarget.Global);
  return { id: pick.id, label: pick.label };
}

/** @param {any} vscode @param {string} message @param {string} absPath @param {(m: string) => void} log */
async function showSent(vscode, message, absPath, log) {
  try {
    const open = await vscode.window.showInformationMessage(`Impact Tree: ${message}`, 'Open file');
    if (open === 'Open file') await vscode.window.showTextDocument(vscode.Uri.file(absPath));
  } catch (e) {
    log(`feedback: showing the sent message failed: ${errorText(e)}`);
  }
}

/**
 * Once per repository: offer the AGENTS.md / CLAUDE.md line. "Not now" asks again in a later
 * window; "Never" and "Add" are remembered for the workspace.
 * @param {any} vscode @param {SendDeps} deps @param {string} repo
 * @param {{ pointerAsked: () => boolean, markPointerAsked: () => void }} o
 */
async function offerPointer(vscode, deps, repo, o) {
  if (o.pointerAsked() || deps.workspaceState.get(POINTER_KEY) !== undefined) return;
  o.markPointerAsked();
  const exists = Object.fromEntries(['AGENTS.md', 'CLAUDE.md'].map((f) => [f, fs.existsSync(path.join(repo, f))]));
  const targets = targetsFor(exists);
  const pick = await vscode.window.showInformationMessage(
    `Point your agents at Impact Tree feedback? This adds one line to ${targets.join(' and ')} so any agent reads open feedback files on its own.`,
    'Add the line', 'Not now', 'Never for this repo');
  if (pick === 'Never for this repo') { await deps.workspaceState.update(POINTER_KEY, 'never'); return; }
  if (pick !== 'Add the line') return;
  try {
    for (const name of targets) {
      const abs = path.join(repo, name);
      const next = withPointer(fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
      if (next !== null) fs.writeFileSync(abs, next);
    }
    await deps.workspaceState.update(POINTER_KEY, 'added');
    vscode.window.showInformationMessage(`Impact Tree: added the feedback line to ${targets.join(' and ')}.`);
  } catch (e) {
    deps.log(`feedback: writing the agent pointer failed: ${errorText(e)}`);
    vscode.window.showErrorMessage(`Impact Tree: could not update ${targets.join(' / ')} (${errorText(e)}).`);
  }
}

module.exports = { chooseAgent, createSendFeedback, saveRound, reviewedLabel, POINTER_KEY };
