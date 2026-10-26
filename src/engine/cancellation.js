// @ts-check
'use strict';
// The one way an analysis says it was stopped rather than that it failed. A cancelled
// run must publish nothing (docs/CODING_STYLE.md section 1), so callers need to tell the
// two apart without matching on message text.

const CANCELLED_CODE = 'ANALYSIS_CANCELLED';

/**
 * Rejection of an operation whose AbortSignal was aborted. It carries no partial result:
 * the work stopped, so nothing it found may be shown as an answer.
 */
class AnalysisCancelledError extends Error {
  /** @param {string} [message] */
  constructor(message = 'analysis cancelled') {
    super(message);
    this.name = 'AnalysisCancelledError';
    /** @readonly */
    this.code = CANCELLED_CODE;
  }
}

/**
 * Whether an error is a cancellation rather than a failure. Checks the code as well as
 * the class, so a copy of this module loaded separately still recognises it.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAnalysisCancelled(error) {
  return error instanceof AnalysisCancelledError
    || (error instanceof Error && /** @type {{ code?: unknown }} */ (error).code === CANCELLED_CODE);
}

/**
 * Stops the caller at a point where stopping is safe. No signal means the operation was
 * not given a way to be cancelled, which is not an error.
 * @param {AbortSignal|undefined} signal
 * @returns {void}
 * @throws {AnalysisCancelledError} When `signal` is aborted.
 */
function throwIfCancelled(signal) {
  if (signal && signal.aborted) throw new AnalysisCancelledError();
}

/**
 * The outcome of a promise as data, so sibling operations all settle before an error is
 * acted on. A cancellation is re-thrown: it is a stop, not a failed step.
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<{ok: true, value: T} | {ok: false, error: unknown}>}
 */
async function attempt(p) {
  try { return { ok: true, value: await p }; }
  catch (error) { if (isAnalysisCancelled(error)) throw error; return { ok: false, error }; }
}

module.exports = { AnalysisCancelledError, isAnalysisCancelled, throwIfCancelled, attempt };
