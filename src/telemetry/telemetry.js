'use strict';
// Anonymous usage events and error reports, sent to PostHog through VS Code's telemetry
// logger. The logger sends nothing when the user turns telemetry off
// (`telemetry.telemetryLevel`), so this module never checks that setting itself.
//
// Privacy rule: the extension reads people's private code, so nothing sent names it. Event
// properties are numbers, booleans and short words from our own fixed lists (`cleanProps`
// drops anything else, such as a path or a symbol name). Error reports carry the error's
// type, our own label for where it happened and stack frames inside the extension's own
// files; never the error's message, which can quote a path, a branch or a PR title.
// docs: telemetry.json lists every event; README "Telemetry" says the same for users.

const path = require('path');
const { realClock } = require('../engine/clock');
const CONFIG = require('./telemetry-config');

const MAX_QUEUE = 200;        // events kept while PostHog cannot be reached; the rest are dropped
const BATCH_SIZE = 20;        // a full batch is sent at once
const FLUSH_MS = 60_000;      // otherwise the queue is sent once a minute
const SEND_TIMEOUT_MS = 5000;
const MAX_FRAMES = 30;

const NO_TELEMETRY = Object.freeze({ event() {}, error() {}, dispose() {} });

/**
 * Keeps only values that cannot name the user's code: finite numbers, booleans and short
 * words made of letters, digits, `.`, `_`, `:` and `-` (no `/`, so no path).
 * @param {Record<string, unknown>} [props]
 * @returns {Record<string, string|number|boolean>}
 */
function cleanProps(props) {
  /** @type {Record<string, string|number|boolean>} */
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (!/^[a-zA-Z][\w.]{0,40}$/.test(k)) continue;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && /^[\w.:-]{0,40}$/.test(v)) out[k] = v;
  }
  return out;
}

/**
 * The frames of a V8 stack that lie in the extension's own files, oldest call first (the
 * order PostHog expects), with paths relative to the extension folder. Frames elsewhere
 * (node, the editor, other extensions) become one `<external>` frame each, without a path.
 * @param {unknown} stack
 * @param {string} root The extension's folder.
 */
function framesOf(stack, root) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[2].replace(/^file:\/\//, '');
    const rel = root ? path.relative(root, file) : '';
    const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const own = inside && !rel.split(path.sep).includes('node_modules');
    frames.push(inside ? {
      filename: rel.split(path.sep).join('/'), function: cleanName(m[1]), lineno: Number(m[3]), colno: Number(m[4]),
      in_app: own, platform: 'node:javascript',
    } : { filename: '<external>', function: '<external>', in_app: false, platform: 'node:javascript' });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

/** A function name from a stack frame, or `<anonymous>`; our code's names say nothing about the user's. */
function cleanName(name) {
  return typeof name === 'string' && /^[\w.$<> ]{1,80}$/.test(name) ? name : '<anonymous>';
}

/** `TypeError`, `Error`… or `Error` for anything that does not look like a class name. */
function typeOf(error) {
  const name = error && typeof error === 'object' ? /** @type {any} */ (error).name : null;
  return typeof name === 'string' && /^[A-Z]\w{0,40}$/.test(name) ? name : 'Error';
}

/**
 * The sender VS Code's telemetry logger calls, but only when the user allows telemetry.
 * Queues PostHog events and posts them in batches; a failed post is dropped, never retried
 * in a loop, and never throws into the caller.
 * @param {{ key: string, host: string, distinctId: string, root: string, log: (m: string) => void,
 *   fetchImpl: typeof fetch, clock: import('../engine/clock').Clock }} o
 */
function createPostHogSender({ key, host, distinctId, root, log, fetchImpl, clock }) {
  /** @type {object[]} */
  let queue = [];
  let warned = false;
  const timer = clock.setInterval(() => { void flush(); }, FLUSH_MS);
  if (clock.unref) clock.unref(timer);

  function push(event, properties) {
    if (queue.length >= MAX_QUEUE) return;
    queue.push({
      event,
      properties: { distinct_id: distinctId, $process_person_profile: false, ...properties },
      timestamp: new Date(clock.now()).toISOString(),
    });
    if (queue.length >= BATCH_SIZE) void flush();
  }

  async function flush() {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      const res = await fetchImpl(`${host.replace(/\/$/, '')}/batch/`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: key, batch }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Once per window: telemetry that cannot be sent is not the user's problem.
      if (!warned) log(`telemetry: ${batch.length} event(s) not sent (${e && /** @type {any} */ (e).message}); later failures are not logged`);
      warned = true;
    }
  }

  return {
    /** @param {string} eventName The logger prefixes our extension id: `publisher.name/event`. */
    sendEventData(eventName, data) {
      push(eventName.slice(eventName.indexOf('/') + 1), cleanCommon(data));
    },
    /** @param {Error} error @param {Record<string, any>} [data] */
    sendErrorData(error, data) {
      const where = data && typeof data.where === 'string' && /^[\w.:-]{1,40}$/.test(data.where) ? data.where : 'unhandled';
      push('$exception', {
        ...cleanCommon(data),
        where,
        $exception_list: [{
          type: typeOf(error), value: where,
          mechanism: { handled: where !== 'unhandled', synthetic: false },
          stacktrace: { type: 'raw', frames: framesOf(error && error.stack, root) },
        }],
      });
    },
    flush,
    dispose() { clock.clearInterval(timer); },
  };
}

/**
 * VS Code mixes its common properties (`common.extversion`, `common.os`, …) into `data`;
 * they and our own event properties go through cleanProps as one.
 * @param {Record<string, any>} [data]
 */
function cleanCommon(data) {
  return cleanProps(data && typeof data === 'object' ? data : {});
}

/**
 * The extension's telemetry. `event` and `error` never throw and never wait.
 * Outside a production install (the Extension Development Host, tests) events are written to
 * the log instead of sent, so a developer can see what would go out.
 * @param {*} vscode
 * @param {{ context: any, log: (m: string) => void, fetchImpl?: typeof fetch,
 *   clock?: import('../engine/clock').Clock, config?: { key: string, host: string } }} o
 * @returns {{ event: (name: string, props?: Record<string, unknown>) => void,
 *   error: (where: string, error: unknown, props?: Record<string, unknown>) => void, dispose: () => void }}
 */
function createTelemetry(vscode, { context, log, fetchImpl = globalThis.fetch, clock = realClock, config = CONFIG }) {
  const env = vscode.env;
  if (!env || typeof env.createTelemetryLogger !== 'function') return NO_TELEMETRY;
  // Only an installed extension sends: the editor always says which mode it runs in, so a
  // missing mode (a test harness) counts as not production.
  const production = !!vscode.ExtensionMode && context.extensionMode === vscode.ExtensionMode.Production;
  const root = context.extensionPath || '';
  const sender = production && config.key && typeof fetchImpl === 'function'
    ? createPostHogSender({ key: config.key, host: config.host, distinctId: env.machineId || 'unknown', root, log, fetchImpl, clock })
    : {
      sendEventData: (name, data) => log(`telemetry (not sent): ${name.slice(name.indexOf('/') + 1)} ${JSON.stringify(cleanProps(data))}`),
      sendErrorData: (error, data) => log(`telemetry (not sent): error ${typeOf(error)} at ${(data && data.where) || 'unhandled'}`),
    };
  let logger;
  try {
    logger = env.createTelemetryLogger(sender);
  } catch (e) {
    log(`telemetry: not available (${e && /** @type {any} */ (e).message})`);
    return NO_TELEMETRY;
  }
  return {
    event(name, props) {
      try { logger.logUsage(name, cleanProps(props)); } catch { /* telemetry never breaks the extension */ }
    },
    error(where, error, props) {
      try {
        const e = error instanceof Error ? error : new Error('non-error thrown');
        logger.logError(e, { ...cleanProps(props), where });
      } catch { /* as above */ }
    },
    dispose() {
      // The logger's dispose asks the sender to flush; the timer stops after.
      try { logger.dispose(); } catch { /* as above */ }
      if ('dispose' in sender) sender.dispose();
    },
  };
}

module.exports = { createTelemetry, cleanProps, framesOf, createPostHogSender, NO_TELEMETRY };
