// @ts-check
'use strict';
// What the usage events say about features, settings and AI agents, as fixed words only.
// The privacy rule of `telemetry.js` holds: a model or client name comes from outside (the
// agent writes it, the MCP client reports it), so it is never sent as written. It is matched
// against our own list and sent as that list's word, or `other`; a model's version is sent
// as digits and dots only. Pure, except `withCommandUsage`, which wraps the editor API.

/** Model families, first match wins (`fable` before `claude`, `codex` before `gpt`). @type {ReadonlyArray<readonly [string, RegExp]>} */
const MODEL_FAMILIES = Object.freeze([
  ['claude-opus', /opus/], ['claude-sonnet', /sonnet/], ['claude-haiku', /haiku/], ['claude-fable', /fable/], ['claude', /claude/],
  ['gpt-codex', /codex/], ['gpt', /gpt/], ['openai-o', /^o\d/],
  ['gemini', /gemini/], ['grok', /grok/], ['deepseek', /deepseek/], ['qwen', /qwen/], ['llama', /llama/],
  ['mistral', /mistral|codestral|devstral/], ['kimi', /kimi/], ['glm', /glm/], ['cursor-composer', /composer/],
]);

/** MCP clients, by the name they give in `initialize`. @type {ReadonlyArray<readonly [string, RegExp]>} */
const CLIENT_FAMILIES = Object.freeze([
  ['claude-code', /claude/], ['cursor', /cursor/], ['codex', /codex/], ['windsurf', /windsurf|codeium/], ['gemini-cli', /gemini/],
  ['copilot', /copilot|visual studio code|vscode/], ['zed', /zed/], ['cline', /cline|roo/], ['continue', /continue/],
  ['goose', /goose/], ['opencode', /opencode/], ['amp', /\bamp\b/], ['kiro', /kiro/],
]);

/**
 * The family of a name from outside, by a fixed list.
 * @param {unknown} name @param {ReadonlyArray<readonly [string, RegExp]>} families
 * @returns {string} `unknown` when none was given, `other` when none matches.
 */
function familyOf(name, families) {
  if (typeof name !== 'string' || !name.trim()) return 'unknown';
  const n = name.trim().toLowerCase();
  const hit = families.find(([, re]) => re.test(n));
  return hit ? hit[0] : 'other';
}

/**
 * A model id as telemetry sends it: its family, and the first version number in it.
 * `claude-opus-5-5` → `{ model: 'claude-opus', modelVersion: '5.5' }`; `gpt-5.1-codex` →
 * `{ model: 'gpt-codex', modelVersion: '5.1' }`. A date stamp (8 digits) is not a version.
 * @param {unknown} id What the agent said its model is.
 * @returns {{ model: string, modelVersion?: string }}
 */
function modelProps(id) {
  const model = familyOf(id, MODEL_FAMILIES);
  if (model === 'unknown' || model === 'other') return { model };
  const m = /(?:^|[^\d])(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/.exec(String(id).toLowerCase());
  return m ? { model, modelVersion: m[2] ? `${m[1]}.${m[2]}` : m[1] } : { model };
}

/** @param {unknown} name The MCP client's name. @returns {string} */
const clientFamily = (name) => familyOf(name, CLIENT_FAMILIES);

/**
 * What an agent's cards answer used, as counts: notes by kind, pseudocode shapes, the
 * attention list and cards. Never the text.
 * @param {any} payload A normalised cards answer.
 * @returns {Record<string, number>}
 */
function cardsAnswerCounts(payload) {
  const changes = payload && Array.isArray(payload.changes) ? payload.changes : [];
  const kinds = (/** @type {string} */ k) => changes.filter((/** @type {any} */ c) => c && c.kind === k).length;
  return {
    notes: changes.length,
    changed: kinds('changed'), mayChange: kinds('may-change'), same: kinds('same'), new: kinds('new'),
    shapes: changes.filter((/** @type {any} */ c) => c && typeof c.shape === 'string' && c.shape !== '').length,
    attention: payload && Array.isArray(payload.attention) ? payload.attention.length : 0,
    cards: payload && Array.isArray(payload.cards) ? payload.cards.length : 0,
  };
}

/**
 * The settings that turn features on or off, as sent with `activated`. An enum's value is
 * sent only when it is one of the enum's words (settings.json can hold anything);
 * free text (a remote, a branch) is sent only as whether it is set.
 * @param {{ get: (key: string, fallback?: any) => any }} config `impactTree`'s configuration.
 * @param {Record<string, readonly string[]>} enums The enum settings and their words, from package.json.
 * @returns {Record<string, string|number|boolean>}
 */
function settingsProps(config, enums) {
  /** @type {Record<string, string|number|boolean>} */
  const out = {};
  for (const [key, words] of Object.entries(enums)) {
    const v = config.get(key);
    if (v !== undefined) out[`set.${key}`] = words.includes(v) ? v : 'other';
  }
  for (const key of ['analyseOnStartup', 'alwaysDiffCallers', 'prewarm', 'openPullRequestTab', 'fetchBase', 'filterInheritedOverReports']) {
    const v = config.get(key);
    if (typeof v === 'boolean') out[`set.${key}`] = v;
  }
  const depth = config.get('reachDepth');
  if (typeof depth === 'number' && Number.isFinite(depth)) out['set.reachDepth'] = depth;
  for (const key of ['githubRemote', 'baseBranch']) out[`set.${key}`] = typeof config.get(key) === 'string' && config.get(key) !== '';
  return out;
}

/** The enum settings from the extension's manifest: `impactTree.mode` → `mode` and its words. @param {any} manifest */
function enumSettingsOf(manifest) {
  /** @type {Record<string, string[]>} */
  const out = {};
  const cfg = manifest && manifest.contributes && manifest.contributes.configuration;
  for (const block of Array.isArray(cfg) ? cfg : cfg ? [cfg] : []) {
    for (const [key, spec] of Object.entries(block.properties || {})) {
      if (key.startsWith('impactTree.') && Array.isArray(/** @type {any} */ (spec).enum)) out[key.slice('impactTree.'.length)] = /** @type {any} */ (spec).enum;
    }
  }
  return out;
}

/**
 * The editor API with `commands.registerCommand` wrapped, so the first run of each of our
 * commands in this window is reported once (`command.used`). Everything else is the API
 * itself (it is the prototype). `report` is read at each run, so it can be set after
 * the commands are registered.
 * @param {any} vscode
 * @param {() => ((command: string) => void)|null} report
 */
function withCommandUsage(vscode, report) {
  const seen = new Set();
  const commands = Object.create(vscode.commands);
  commands.registerCommand = (/** @type {string} */ id, /** @type {(...a: any[]) => any} */ fn, /** @type {any} */ thisArg) =>
    vscode.commands.registerCommand(id, (/** @type {any[]} */ ...args) => {
      if (!seen.has(id)) {
        const send = report();
        if (send) { seen.add(id); try { send(id.replace(/^impactTree\./, '')); } catch { /* telemetry never breaks a command */ } }
      }
      return fn.apply(thisArg, args);
    });
  return Object.create(vscode, { commands: { value: commands, enumerable: true } });
}

module.exports = { modelProps, clientFamily, cardsAnswerCounts, settingsProps, enumSettingsOf, withCommandUsage, MODEL_FAMILIES, CLIENT_FAMILIES };
