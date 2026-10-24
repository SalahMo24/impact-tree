'use strict';
// The project's lint rule against reading the wall clock outside src/engine/clock.js
// (eslint-local/no-wall-clock.js): what it reports, what its allowlist comments permit,
// and that a stale or malformed allowlist comment is itself an error.
const test = require('node:test');
const { RuleTester } = require('eslint');
const globals = require('globals');
const rule = require('../eslint-local/no-wall-clock');

// RuleTester calls describe/it; map them onto node:test.
RuleTester.describe = (name, fn) => fn();
RuleTester.it = (name, fn) => test(name, fn);
RuleTester.itOnly = RuleTester.it;

const tester = new RuleTester({ languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022, globals: globals.node } });
const direct = (what) => ({ messageId: 'direct', data: { what, categories: 'log-only, next-turn, display, subprocess' } });

tester.run('no-wall-clock', rule, {
  valid: [
    // Time from an injected clock.
    'function f(clock) { const t = clock.now(); clock.setTimeout(() => {}, t); }',
    // A local binding of the same name is not the global timer.
    'function f(clock) { const { setTimeout } = clock; setTimeout(() => {}, 5); }',
    'function setTimeout() {} setTimeout();',
    'const Date = { now: () => 0 }; Date.now();',
    // A Date of a given time is not "now".
    'const d = new Date(0); const e = new Date(ms);',
    // The allowlist, on the line or the line above, with each category.
    '// wall-clock: log-only — duration for the log\nconst t = Date.now();',
    'const t = Date.now(); // wall-clock: log-only -- duration for the log',
    '// wall-clock: display — the time of day in a label\nconst d = new Date();',
    '// wall-clock: next-turn — batch to the next turn\nconst h = setTimeout(() => {}, 0);',
    '// wall-clock: next-turn — clear the pending batch\nclearTimeout(h);',
    '// wall-clock: subprocess — the OS enforces this\nconst s = performance.now();',
  ],
  invalid: [
    { code: 'const t = Date.now();', errors: [direct('Date.now')] },
    { code: 'const now = Date.now;', errors: [direct('Date.now')] },
    { code: 'const d = new Date();', errors: [direct('new Date()')] },
    { code: 'setTimeout(() => {}, 1000);', errors: [direct('setTimeout')] },
    { code: 'const h = setInterval(f, 10); clearInterval(h);', errors: [direct('setInterval'), direct('clearInterval')] },
    { code: 'globalThis.setTimeout(f, 5);', errors: [direct('setTimeout')] },
    { code: 'const t = performance.now(); const h = process.hrtime();', errors: [direct('performance.now'), direct('process.hrtime')] },
    // An allowlist comment two lines up does not cover the use.
    { code: '// wall-clock: log-only — too far\n\nconst t = Date.now();', errors: [{ messageId: 'unused' }, direct('Date.now')] },
    // Unknown category, or no reason.
    { code: '// wall-clock: because — reasons\nconst t = Date.now();', errors: [{ messageId: 'badMarker' }, direct('Date.now')] },
    { code: '// wall-clock: log-only\nconst t = Date.now();', errors: [{ messageId: 'badMarker' }, direct('Date.now')] },
    // next-turn allows only the literal 0.
    { code: '// wall-clock: next-turn — not really\nsetTimeout(f, 10);', errors: [{ messageId: 'notZero' }] },
    // A stale allowlist comment.
    { code: '// wall-clock: log-only — nothing here any more\nconst t = 1;', errors: [{ messageId: 'unused' }] },
  ],
});
