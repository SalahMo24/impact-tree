#!/usr/bin/env node
'use strict';
// A development tool: try "Analyse with my agent" on a real repository without the editor, and
// look at what the reviewer would see. It uses the extension's own code for each step.
//
//   1. node src/cli.js --repo R --mode branch --json --impact --cards > result.json
//   2. node scripts/preview-agent-review.js facts  --repo R --result result.json --out DIR
//        writes DIR/facts.json and DIR/prompt.txt (the prompt names the facts file)
//   3. give DIR/prompt.txt to an agent; have it write its `answer` to a file instead of calling submit_cards
//   4. node scripts/preview-agent-review.js check  --repo R --result result.json --answer answer.json
//        prints what submit_cards would answer: ok, errors, dropped
//   5. node scripts/preview-agent-review.js render --repo R --result result.json --answer answer.json --out DIR
//        writes DIR/review.html (the Review tab) and DIR/notes.html (each diff-editor note), to open in a browser
//
// The diff is `git diff <base>` of the working tree, as the Review tab and the facts use it. Colours
// stand in for a dark VS Code theme; the pages are a preview, not the editor.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildCardFacts, factsFileText, splitDiff } = require('../src/engine/card-facts');
const { hunkFor, callsFor } = require('../src/engine/card-env');
const { validateSubmission } = require('../src/engine/agent-results');
const { buildCardsPrompt } = require('../src/agent/agent-prompt');
const { reviewTabModel } = require('../src/views/review-tab/review-tab-model');
const { buildReviewTabHtml } = require('../src/views/review-tab/review-tab-html');
const { noteMarkdown } = require('../src/diff-editor/agent-threads-model');
const { classifyChangeVerdict } = require('../src/views/changes/tree-row-models');

/** VS Code theme variables the pages read, with dark-theme values. */
const THEME = `:root { --vscode-foreground: #cccccc; --vscode-font-family: -apple-system, system-ui, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, monospace; --vscode-editor-font-size: 12px; --vscode-descriptionForeground: #9d9d9d;
  --vscode-panel-border: #3c3c3c; --vscode-textCodeBlock-background: #2b2b2b; --vscode-errorForeground: #f48771;
  --vscode-editorWarning-foreground: #cca700; --vscode-textLink-foreground: #4daafc; --vscode-focusBorder: #0078d4;
  --vscode-diffEditor-insertedLineBackground: rgba(155,185,85,.2); --vscode-diffEditor-removedLineBackground: rgba(255,0,0,.2);
  --vscode-button-background: #0078d4; --vscode-button-foreground: #fff; --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ccc; --vscode-list-hoverBackground: #2a2d2e; --vscode-list-activeSelectionBackground: #04395e;
  --vscode-editor-background: #1e1e1e; --vscode-sideBar-background: #181818; }
body { background: var(--vscode-editor-background); }`;

/** @param {string[]} argv @returns {Record<string, string>} */
function flags(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** @param {Record<string, string>} f @param {string} name */
function need(f, name) {
  if (!f[name]) throw new Error(`--${name} is required`);
  return f[name];
}

/** The analysis, its cards, the file diffs and the head commit. @param {Record<string, string>} f */
function load(f) {
  const repo = path.resolve(need(f, 'repo'));
  const result = JSON.parse(fs.readFileSync(need(f, 'result'), 'utf8'));
  if (!result.cards) throw new Error('the result has no cards: run the CLI with --impact --cards');
  const base = result.base && result.base.sha;
  if (!base) throw new Error('the result has no base commit');
  const diff = execFileSync('git', ['-C', repo, 'diff', '--no-color', '-U3', '--no-ext-diff', base, '--'], { maxBuffer: 256 * 1024 * 1024 }).toString();
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
  const cards = { clusters: result.cards.clusters || [], sweeps: result.cards.sweeps || [], seams: result.cards.seams || [], hints: result.cards.hints || [] };
  return { repo, result, cards, diffOf: splitDiff(diff), head, base, baseRef: result.base.ref || null };
}

/** @param {string} abs @returns {string|null} */
const readText = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };

/** submit_cards' check of an answer file. @param {ReturnType<typeof load>} l @param {string} file */
function check(l, file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateSubmission('cards', raw.answer || raw, { result: l.result, cards: l.cards, readText: (rel) => readText(path.join(l.repo, rel)) });
}

/** @param {string} body @param {string} title */
const page = (body, title) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title><style>${THEME}</style></head><body>${body}</body></html>`;

/** @param {ReturnType<typeof load>} l @param {Record<string, string>} f */
function render(l, f) {
  const out = path.resolve(need(f, 'out'));
  fs.mkdirSync(out, { recursive: true });
  const r = check(l, need(f, 'answer'));
  if (!r.ok) throw new Error(`the answer does not pass the check:\n${r.errors.join('\n')}`);
  const payload = r.normalised;
  const env = { ctx: { diffOf: l.diffOf }, diffCache: new Map() };
  const model = reviewTabModel({
    result: l.result, cards: l.cards, agentPayload: payload, title: path.basename(l.repo),
    hunkOf: (c) => hunkFor(env, c).text, callsOf: (c) => callsFor(env, c, readText),
    rel: (abs) => path.relative(l.repo, abs),
  });
  // The tab as the editor builds it; the page script gets a stand-in for the webview API.
  const tab = buildReviewTabHtml(model, { nonce: 'cHJldmlldw==', cspSource: 'self' })
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<head>', `<head><style>${THEME}</style><script>window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage() {} });</script>`);
  fs.writeFileSync(path.join(out, 'review.html'), tab);

  // Each diff-editor note, in card order, rendered as VS Code renders comment markdown.
  const md = require('markdown-it')({ html: false, linkify: false });
  const changed = new Map((l.result.allChanged || []).map((/** @type {any} */ c) => [`${c.relPath}#${c.namePos}`, c]));
  const notes = (payload.changes || []).map((/** @type {any} */ c) => {
    const engine = changed.get(c.id);
    const body = noteMarkdown(c, { verdict: engine ? classifyChangeVerdict(engine).text : 'not in this analysis', callers: engine ? engine.callers || [] : [] });
    return `<section class="note"><div class="where">${md.utils.escapeHtml(engine ? `${engine.relPath}:${engine.startLine} ${engine.label}` : c.id)}</div>`
      + `<div class="who">✦ Your agent</div>${md.render(body)}</section>`;
  });
  const style = `<style>body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; padding: 16px; max-width: 900px; }
.note { border-top: 2px solid var(--vscode-focusBorder); background: #252526; margin: 0 0 18px; padding: 6px 14px 10px; }
.where { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); font-size: 12px; }
.who { font-weight: 600; margin: 4px 0; } a { color: var(--vscode-textLink-foreground); }
pre { background: var(--vscode-textCodeBlock-background); padding: 6px 10px; font-family: var(--vscode-editor-font-family); font-size: 12px; overflow-x: auto; }
code.language-diff { white-space: pre; }</style>`;
  // VS Code colours a diff block's + and - lines; this stand-in does the same per line.
  const colour = (/** @type {string} */ html) => html.replace(/<code class="language-diff">([\s\S]*?)<\/code>/g, (_, inner) => `<code class="language-diff">${inner.split('\n')
    .map((/** @type {string} */ line) => (line.startsWith('+') ? `<span style="color:#89d185">${line}</span>` : line.startsWith('-') ? `<span style="color:#f48771">${line}</span>` : line)).join('\n')}</code>`);
  fs.writeFileSync(path.join(out, 'notes.html'), page(`${style}<h2>Diff-editor notes · ${notes.length}</h2>${colour(notes.join(''))}`, 'Agent notes'));
  return { out, dropped: r.dropped || [], changes: (payload.changes || []).length, withShape: (payload.changes || []).filter((/** @type {any} */ c) => c.shape).length };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const l = load(f);
  if (cmd === 'facts') {
    const out = path.resolve(need(f, 'out'));
    fs.mkdirSync(out, { recursive: true });
    const facts = buildCardFacts({ repo: l.repo, result: l.result, cards: l.cards, diffOf: l.diffOf, readText }, { head: l.head, base: l.base, baseRef: l.baseRef });
    const factsPath = path.join(out, 'facts.json');
    fs.writeFileSync(factsPath, factsFileText(facts.facts));
    fs.writeFileSync(path.join(out, 'prompt.txt'), buildCardsPrompt({ repo: l.repo, base: { ref: l.baseRef, sha: l.base }, head: l.head }, { factsPath, cut: facts.cut }));
    const members = facts.facts.cards.flatMap((/** @type {any} */ c) => c.members || []);
    console.log(JSON.stringify({ facts: factsPath, prompt: path.join(out, 'prompt.txt'), members: members.length, withCalls: members.filter((/** @type {any} */ m) => m.calls).length, cut: facts.cut }));
  } else if (cmd === 'check') {
    const r = check(l, need(f, 'answer'));
    console.log(JSON.stringify({ ok: r.ok, errors: r.errors, dropped: r.dropped || [] }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'render') {
    console.log(JSON.stringify(render(l, f), null, 2));
  } else {
    throw new Error('usage: preview-agent-review.js facts|check|render --repo R --result result.json [--answer a.json] [--out DIR]');
  }
}

main();
