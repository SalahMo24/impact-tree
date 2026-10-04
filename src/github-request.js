// @ts-check
'use strict';
// The single path every GitHub request takes: a deadline, the caller's cancellation, and
// a response-size limit enforced while the body streams in. It knows nothing about which
// endpoint is called or what the JSON means; src/github.js decides that.

const { AnalysisCancelledError } = require('./engine/cancellation');

/**
 * Limits on what one GitHub call may cost. Owner: src/github.js (`createGitHub` takes
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
 * - `maxJsonBytes`: bytes, default 10 MiB. The response to any JSON API call; enforced
 *   and exhausted the same way as `maxFileBytes`.
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
 * @param {RequestInit} init Must not carry its own `signal`.
 * @param {object} bounds
 * @param {string} bounds.endpoint Names the request in errors; carries no credentials.
 * @param {number} bounds.deadlineMs
 * @param {number} bounds.maxBytes
 * @param {AbortSignal} [bounds.signal]
 * @param {number[]} [bounds.passStatuses] Statuses returned with `text: null` instead of
 *   rejecting, e.g. 404 where "absent" is an answer.
 * @returns {Promise<BoundedResponse>}
 * @throws {GitHubCancelledError} `bounds.signal` was aborted.
 * @throws {GitHubTimeoutError} The deadline passed.
 * @throws {GitHubResponseTooLargeError} The body passed `maxBytes`.
 * @throws {GitHubAuthError} The status was 401.
 * @throws {GitHubHttpError} Any other unaccepted non-2xx status.
 */
async function fetchBounded(fetchImpl, url, init, bounds) {
  const { endpoint, deadlineMs, maxBytes, signal, passStatuses = [] } = bounds;
  if (signal && signal.aborted) throw new GitHubCancelledError(endpoint);

  const controller = new AbortController();
  /** @type {Error|null} */
  let cause = null;
  const stop = (/** @type {Error} */ error) => {
    if (!cause) { cause = error; controller.abort(); }
  };
  const onCallerAbort = () => stop(new GitHubCancelledError(endpoint));
  if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => stop(new GitHubTimeoutError(endpoint, deadlineMs)), deadlineMs);

  // Raced against every await, so a fetch that ignores its signal still stops on time.
  const stopped = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(cause), { once: true });
  });
  stopped.catch(() => {});
  const until = (/** @type {Promise<any>} */ work) => Promise.race([work, stopped]);

  /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
  let reader = null;
  try {
    const res = await until(fetchImpl(url, { ...init, signal: controller.signal }));
    if (cause) throw cause;
    if (res.status === 401) throw new GitHubAuthError(res.status);
    if (passStatuses.includes(res.status)) return { status: res.status, contentType: '', text: null };
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
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
    // Frees the connection when we stopped early; harmless after a complete read.
    if (reader) reader.cancel().catch(() => {});
    controller.abort();
  }
}

module.exports = {
  DEFAULT_LIMITS, fetchBounded,
  GitHubTimeoutError, GitHubCancelledError, GitHubResponseTooLargeError,
  GitHubAuthError, GitHubHttpError, GitHubResponseError,
};
