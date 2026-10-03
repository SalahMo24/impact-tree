// @ts-check
'use strict';
// Validators for the numeric settings that bound work. One rule for all of them, so a bad
// value cannot behave differently per setting: omitted means the default, an unusable
// value falls back to the default with a warning, and a value above the maximum is clamped
// with a warning. The ranges here are the ones declared in package.json.

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;
const DEFAULT_REACH_DEPTH = 2;
const MAX_REACH_DEPTH = 6;
// GitHub's client lists at most this many files whatever it is asked for.
const DEFAULT_TIER_A_MAX_FILES = 300;
const MAX_TIER_A_MAX_FILES = 3000;

/** @param {unknown} v @returns {string} */
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * Turn a supplied setting into an integer from 1 to `max`. Omitted (undefined or null)
 * means `fallback`. Anything unusable falls back to `fallback` and pushes a warning onto
 * `warnings`; a value above the maximum is clamped, also with a warning. Fractions round down.
 * @param {string} setting Setting name, as shown to the user.
 * @param {unknown} value The raw setting.
 * @param {{ fallback: number, max: number }} range
 * @param {string[]} warnings Receives one message per correction.
 * @returns {number} An integer from 1 to `max`.
 */
function validateCount(setting, value, { fallback, max }, warnings) {
  if (value === undefined || value === null) return fallback;
  const whole = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!(whole >= 1)) {
    warnings.push(`${setting} is ${show(value)}, which is not a number from 1 to ${max}; using ${fallback}`);
    return fallback;
  }
  if (whole > max) {
    warnings.push(`${setting} is ${show(value)}, above the maximum; using ${max}`);
    return max;
  }
  return whole;
}

/**
 * @param {unknown} value The raw `impactTree.concurrency`.
 * @param {string[]} warnings Receives one message per correction.
 * @returns {number} An integer from 1 to MAX_CONCURRENCY.
 */
const validateConcurrency = (value, warnings) =>
  validateCount('impactTree.concurrency', value, { fallback: DEFAULT_CONCURRENCY, max: MAX_CONCURRENCY }, warnings);

/**
 * @param {unknown} value The raw `impactTree.reachDepth`.
 * @param {string[]} warnings Receives one message per correction.
 * @returns {number} An integer from 1 to MAX_REACH_DEPTH.
 */
const validateReachDepth = (value, warnings) =>
  validateCount('impactTree.reachDepth', value, { fallback: DEFAULT_REACH_DEPTH, max: MAX_REACH_DEPTH }, warnings);

/**
 * @param {unknown} value The raw `impactTree.tierA.maxFiles`.
 * @param {string[]} warnings Receives one message per correction.
 * @returns {number} An integer from 1 to MAX_TIER_A_MAX_FILES.
 */
const validateTierAMaxFiles = (value, warnings) =>
  validateCount('impactTree.tierA.maxFiles', value, { fallback: DEFAULT_TIER_A_MAX_FILES, max: MAX_TIER_A_MAX_FILES }, warnings);

module.exports = {
  validateConcurrency, validateReachDepth, validateTierAMaxFiles,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_REACH_DEPTH, MAX_REACH_DEPTH,
  DEFAULT_TIER_A_MAX_FILES, MAX_TIER_A_MAX_FILES,
};
