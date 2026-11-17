// @ts-check
'use strict';
// The single path every GitHub request takes: a deadline, the caller's cancellation, and
// a response-size limit enforced while the body streams in. It knows nothing about which
// endpoint is called or what the JSON means; src/github/github.js decides that.

const { AnalysisCancelledError } = require('../engine/cancellation');
const { realClock } = require('../engine/clock');

/**
 * Limits on what one GitHub call may cost. Owner: src/github/github.js (`createGitHub` takes
 * overrides through its `limits` option; the extension passes none). Chosen by the
 * product owner; revisit if real repositories hit them.
 *
 * - `requestTimeoutMs`: milliseconds, default 30,000. One request from sending to the
 *   last body byte, enforced by a timer in `fetchBounded`. Exhaustion: the request is
 *   aborted and rejects with `GitHubTimeoutError`.
 * - `maxFileBytes`: bytes, default 2 MiB. The response to a file fetch, enforced in
 *   `fetchBounded` as chunks arrive, so peak memory is the limit plus one chunk.
 *   Exhaustion: the body is cancelled and the call rejects with
 *   `GitHubResponseTooLargeError`. A PR preview reports that file as "fetch failed —
 *   skipped" and stays visibly incomplete.
 * - `maxJsonBytes`: bytes, default 10 MiB. The response to any JSON API call, including
 *   GraphQL queries and the response to a write (POST/PUT/PATCH/DELETE); enforced and
 *   exhausted the same way as `maxFileBytes`. `requestTimeoutMs` covers writes and
 *   GraphQL too. A request is sent again only when its connection failed before any
 *   response (`CONNECTION_RETRIES`), and only a GET: a write must not be sent twice. Any
 *   other failure rejects with its typed error at once, so the caller decides. A rate
 *   limit rejects at once with `GitHubRateLimitError`; the extension never sleeps until
 *   the reset.
 * - `maxPullRequestPages`: pages of 100, default 10 (1,000 pull requests). Enforced by
 *   `listOpenPullRequests`. Exhaustion: the list is returned truncated, and says so
 *   only when one more page proves that there were more.
 * - `maxTeamPages`: pages of 100, default 3 (300 teams). Enforced by `listMyTeams`.
 *   Exhaustion: the team list is returned truncated under the same rule, and the PR
 *   view says that review requests to further teams may be missed.
 */
const DEFAULT_LIMITS = Object.freeze({
  requestTimeoutMs: 30 * 1000,
  maxFileBytes: 2 * 1024 * 1024,
  maxJsonBytes: 10 * 1024 * 1024,
  maxPullRequestPages: 10,
  maxTeamPages: 3,
});

/**
 * Connection failures sent again. Unit: further attempts after the first, for one GET whose
 * connection failed before a response. Default 1. Owner: `fetchBounded`, under the same
 * `requestTimeoutMs` deadline (no extra time). Exhaustion: the call rejects with
 * `GitHubNetworkError` naming the cause. Why one: the preview's own measurements show a
 * refused connection in the editor host coming and going within seconds; a second
 * attempt recovers that, and a host that is offline fails the second time just as fast.
 */
const CONNECTION_RETRIES = 1;

/**
 * The connection to GitHub failed before any response: a refused or reset connection, a
 * name that did not resolve, or a connection that was not made in time. `fetch` reports
 * these as a bare "fetch failed"; the cause (its `code` or message) is kept here so the
 * log names the network error.
 */
class GitHubNetworkError extends Error {
  /** @param {string} endpoint @param {unknown} cause */
  constructor(endpoint, cause) {
    super(`GitHub could not be reached for ${endpoint}: ${describeCause(cause)}`);
    this.name = 'GitHubNetworkError';
    this.cause = cause;
  }
}

/** @param {unknown} error @returns {string} The network cause of a failed fetch, as a short phrase. */
function describeCause(error) {
  const e = /** @type {{ cause?: unknown, code?: unknown, message?: unknown }|null} */ (error && typeof error === 'object' ? error : null);
  const inner = e && e.cause && typeof e.cause === 'object' ? /** @type {{ code?: unknown, message?: unknown }} */ (e.cause) : null;
  const code = (inner && typeof inner.code === 'string' && inner.code) || (e && typeof e.code === 'string' && e.code) || null;
  const message = (inner && typeof inner.message === 'string' && inner.message) || (e && typeof e.message === 'string' && e.message) || 'fetch failed';
  return code && !message.includes(code) ? `${code} (${message})` : message;
}

/**
 * Whether `fetch` rejected because no connection could be made or it broke before the
 * response: a `TypeError` (what the fetch standard throws for a network error), or an
 * error carrying a system error code. An abort, a deadline or a response with a status
 * is not one.
 * @param {unknown} error
 */
function isConnectionFailure(error) {
  if (!error || typeof error !== 'object') return false;
  const e = /** @type {{ name?: unknown, code?: unknown }} */ (error);
  if (e.name === 'AbortError') return false;
  return error instanceof TypeError || e.name === 'TypeError' || typeof e.code === 'string';
}

/** The request outlived its deadline. */
class GitHubTimeoutError extends Error {
  /** @param {string} endpoint @param {number} deadlineMs */
  constructor(endpoint, deadlineMs) {
    super(`GitHub did not answer ${endpoint} within ${deadlineMs / 1000}s`);
    this.name = 'GitHubTimeoutError';
  }
}

/**
 * The caller's signal aborted the request. It is an `AnalysisCancelledError`, so the
 * session treats it as a stop and not as a failure to report.
 */
class GitHubCancelledError extends AnalysisCancelledError {
  /** @param {string} endpoint */
  constructor(endpoint) {
    super(`request to ${endpoint} cancelled`);
    this.name = 'GitHubCancelledError';
  }
}

/** The response body passed its size limit while streaming. */
class GitHubResponseTooLargeError extends Error {
  /** @param {string} endpoint @param {number} maxBytes */
  constructor(endpoint, maxBytes) {
    super(`GitHub's response from ${endpoint} is larger than the ${maxBytes}-byte limit`);
    this.name = 'GitHubResponseTooLargeError';
  }
}

/** GitHub refused the token. The caller drops its session on this. */
class GitHubAuthError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`GitHub rejected the token (${status}) — sign in again`);
    this.name = 'GitHubAuthError';
  }
}

/**
 * GitHub refused because a rate limit is spent: 429, a 403 with `x-ratelimit-remaining:
 * 0` or with `retry-after` (a secondary limit), or a GraphQL `RATE_LIMITED` error. The
 * token is fine, so the caller keeps its session.
 */
class GitHubRateLimitError extends Error {
  /**
   * @param {string} endpoint
   * @param {number} status
   * @param {number|null} resetAt Epoch milliseconds when requests may resume, or null
   *   when GitHub sent neither `retry-after` nor `x-ratelimit-reset`.
   */
  constructor(endpoint, status, resetAt) {
    super(`GitHub rate limit reached on ${endpoint} (${status})`
      + (resetAt === null ? '' : `; resets at ${new Date(resetAt).toISOString()}`));
    this.name = 'GitHubRateLimitError';
    this.status = status;
    this.resetAt = resetAt;
  }
}

/**
 * A GraphQL answer carried a non-empty `errors` array. Raised even when `data` is also
 * present, so partial data is never used as if it were complete.
 */
class GitHubGraphQLError extends Error {
  /**
   * @param {string} endpoint
   * @param {{ message: string, path: (string|number)[]|null, type: string|null }[]} errors
   */
  constructor(endpoint, errors) {
    super(`GitHub GraphQL error on ${endpoint}: ${errors.map((e) => e.message).join('; ')}`);
    this.name = 'GitHubGraphQLError';
    this.errors = errors;
    this.messages = errors.map((e) => e.message);
  }
}

/** GitHub answered with a status the caller did not expect. */
class GitHubHttpError extends Error {
  /** @param {string} endpoint @param {number} status */
  constructor(endpoint, status) {
    super(`GitHub ${status} on ${endpoint}`);
    this.name = 'GitHubHttpError';
    this.status = status;
  }
}

/** GitHub's answer was not the shape this extension relies on. */
class GitHubResponseError extends Error {
  /** @param {string} endpoint @param {string} problem */
  constructor(endpoint, problem) {
    super(`unexpected response from ${endpoint}: ${problem}`);
    this.name = 'GitHubResponseError';
  }
}

/**
 * When a rate limit lifts, in epoch milliseconds: `retry-after` (seconds from now) wins
 * over `x-ratelimit-reset` (epoch seconds). Headers that are not whole numbers are
 * ignored rather than trusted.
 * @param {{ get: (name: string) => string|null }} headers
 * @param {number} nowMs Epoch milliseconds the response arrived at.
 * @returns {number|null}
 */
function rateLimitResetAt(headers, nowMs) {
  /** @param {string} name */
  const whole = (name) => {
    const raw = headers.get(name);
    return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  };
  const retryAfter = whole('retry-after');
  if (retryAfter !== null) return nowMs + retryAfter * 1000;
  const reset = whole('x-ratelimit-reset');
  return reset !== null ? reset * 1000 : null;
}

/**
 * @typedef {object} BoundedResponse
 * @property {number} status
 * @property {string} contentType Lower-cased `content-type`, or an empty string.
 * @property {string|null} text The body, or null when the status was one the caller
 *   asked to handle itself (`passStatuses`), in which case the body was not read.
 */

/**
 * Sends one request and reads its body under a deadline, the caller's signal and a
 * size limit. Nothing is parsed or returned once the request was cancelled, even if the
 * body was already arriving.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init Method, headers and body pass through unchanged; must not
 *   carry its own `signal`. The request is sent once whatever the method.
 * @param {object} bounds
 * @param {string} bounds.endpoint Names the request in errors; carries no credentials.
 * @param {number} bounds.deadlineMs
 * @param {number} bounds.maxBytes
 * @param {AbortSignal} [bounds.signal]
 * @param {number[]} [bounds.passStatuses] Statuses returned with `text: null` instead of
 *   rejecting, e.g. 404 where "absent" is an answer.
 * @param {import('../engine/clock').Clock} [bounds.clock] Times the deadline and dates a
 *   rate limit's `retry-after` (src/engine/clock.js).
 * @returns {Promise<BoundedResponse>}
 * @throws {GitHubCancelledError} `bounds.signal` was aborted.
 * @throws {GitHubTimeoutError} The deadline passed.
 * @throws {GitHubResponseTooLargeError} The body passed `maxBytes`.
 * @throws {GitHubAuthError} The status was 401.
 * @throws {GitHubRateLimitError} The status was 429, or 403 with no requests remaining or
 *   with `retry-after`.
 * @throws {GitHubHttpError} Any other unaccepted non-2xx status.
 */
async function fetchBounded(fetchImpl, url, init, bounds) {
  const { endpoint, deadlineMs, maxBytes, signal, passStatuses = [], clock = realClock } = bounds;
  if (signal && signal.aborted) throw new GitHubCancelledError(endpoint);

  const controller = new AbortController();
  /** @type {Error|null} */
  let cause = null;
  const stop = (/** @type {Error} */ error) => {
    if (!cause) { cause = error; controller.abort(); }
  };
  const onCallerAbort = () => stop(new GitHubCancelledError(endpoint));
  if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });
  const timer = clock.setTimeout(() => stop(new GitHubTimeoutError(endpoint, deadlineMs)), deadlineMs);

  // Raced against every await, so a fetch that ignores its signal still stops on time.
  const stopped = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(cause), { once: true });
  });
  stopped.catch(() => {});
  const until = (/** @type {Promise<any>} */ work) => Promise.race([work, stopped]);

  /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
  let reader = null;
  try {
    let res;
    // A GET whose connection failed before any response is sent once more, within the same
    // deadline (`CONNECTION_RETRIES`); the second failure names the network cause.
    for (let attempt = 0; ; attempt++) {
      try {
        res = await until(fetchImpl(url, { ...init, signal: controller.signal }));
        break;
      } catch (error) {
        if (cause) throw cause;
        if (!isConnectionFailure(error)) throw error;
        const retriable = (init.method === undefined || init.method === 'GET') && attempt < CONNECTION_RETRIES;
        if (!retriable) throw new GitHubNetworkError(endpoint, error);
      }
    }
    if (cause) throw cause;
    if (res.status === 401) throw new GitHubAuthError(res.status);
    if (passStatuses.includes(res.status)) return { status: res.status, contentType: '', text: null };
    // A secondary rate limit is a 403 with `retry-after` and requests still remaining.
    const limited = res.status === 429 || (res.status === 403
      && (String(res.headers.get('x-ratelimit-remaining')).trim() === '0' || res.headers.get('retry-after') !== null));
    if (limited) throw new GitHubRateLimitError(endpoint, res.status, rateLimitResetAt(res.headers, clock.now()));
    if (!res.ok) throw new GitHubHttpError(endpoint, res.status);
    if (!res.body) throw new GitHubResponseError(endpoint, 'no response body');

    const body = res.body.getReader();
    reader = body;
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await until(body.read());
      if (cause) throw cause;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new GitHubResponseTooLargeError(endpoint, maxBytes);
      chunks.push(value);
    }
    return {
      status: res.status,
      contentType: (res.headers.get('content-type') || '').toLowerCase(),
      text: Buffer.concat(chunks).toString('utf8'),
    };
  } catch (error) {
    // A fetch aborted by us rejects with its own AbortError; report the real reason.
    throw cause || error;
  } finally {
    clock.clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
    // Frees the connection when we stopped early; harmless after a complete read.
    if (reader) reader.cancel().catch(() => {});
    controller.abort();
  }
}

module.exports = {
  DEFAULT_LIMITS, CONNECTION_RETRIES, fetchBounded,
  GitHubNetworkError, GitHubTimeoutError, GitHubCancelledError, GitHubResponseTooLargeError,
  GitHubAuthError, GitHubHttpError, GitHubResponseError,
  GitHubRateLimitError, GitHubGraphQLError,
};
