'use strict';
// The extension analyses a repo; it does not live inside one. The suite runs against the
// synthetic fixture repository (test/fixture-repo.js) unless IMPACT_TREE_TARGET_REPO
// points at a real one, so `npm test` is self-contained and deterministic, and a check
// can still be aimed at any codebase by hand.
//
// The fixture is a small TypeScript monorepo with a branch that changes signatures,
// bodies, a .tsx component and a README. It has no NestJS, DI container or CQRS; the
// port/adapter, command handler and deep-inheritance paths are covered by the synthetic
// programs in test/syntactic-index.test.js and test/inheritance.test.js.
const path = require('path');

/** @returns {string} Absolute path of the repository the suite analyses. */
module.exports = function targetRepo() {
  const env = process.env.IMPACT_TREE_TARGET_REPO;
  if (env) return path.resolve(env);
  return require('./fixture-repo').fixtureRepo();
};

/** Whether the suite was pointed at a repository of the caller's choosing. */
module.exports.isExternal = () => !!process.env.IMPACT_TREE_TARGET_REPO;

/**
 * A check that found nothing to check in the target. Against the built-in fixture that
 * is a bug (the fixture always has a diff), and in CI a silent skip would be a green run
 * that ran nothing; both exit 1. Against a repository chosen by hand it is a legitimate
 * state, explained and exited 0.
 * @param {string} suite What did not run.
 * @param {string[]} lines Why, and what would make it run.
 */
module.exports.skipOrFail = (suite, lines) => {
  const fatal = !module.exports.isExternal() || !!process.env.CI;
  for (const line of lines) console.log(`  ${fatal ? 'FAIL' : 'skip'}  ${line}`);
  console.log(fatal
    ? `\n${suite} checks did NOT run${module.exports.isExternal() ? ' (CI is set: a skip fails the run)' : ' against the built-in fixture, which always has a diff'}`
    : `\n${suite} checks did NOT run`);
  process.exit(fatal ? 1 : 0);
};
