'use strict';
const path = require('path');
const ts = require('typescript');
const { createSyntacticIndex } = require('../src/engine/syntactic-index');
const { createGitHub } = require('../src/github');
const assert = require('node:assert/strict');

const root = '/review';
const build = (files) => createSyntacticIndex(ts, Object.entries(files).map(([p, text]) => ({ path: path.join(root, p), text })), { baseDirs: [root] });

const response = (status, data, contentType = 'application/json') => ({ status, ok: status >= 200 && status < 300,
  headers: { get: () => contentType }, body: new Blob([typeof data === 'string' ? data : JSON.stringify(data)]).stream() });
const client = async () => { const gh = createGitHub({ authentication: { getSession: async () => ({ accessToken: 'test' }) } }); await gh.signIn(); return gh; };

const CONCURRENCY_CASES = [
  [0, 'invalid'], [-1, 'invalid'], [NaN, 'invalid'], [0.5, 'invalid'], ['abc', 'invalid'], [Infinity, 'invalid'],
  [null, 'omitted'], [undefined, 'omitted'], [1, 'ok'], [2.7, 'ok'], [32, 'ok'], [33, 'clamped'], [1000, 'clamped'],
];
const concurrencyWarnings = (r) => r.warnings.filter((w) => w.includes('impactTree.concurrency'));
const assertConcurrencyWarnings = (r, kind, value) => {
  const used = { invalid: 8, omitted: 8, clamped: 32 }[kind] ?? Math.floor(value);
  assert.equal(r.concurrency, used, `${String(value)} reports the worker count it used`);
  const found = concurrencyWarnings(r);
  if (kind === 'invalid' || kind === 'clamped') {
    assert.equal(found.length, 1, `${String(value)}: ${JSON.stringify(r.warnings)}`);
    assert.ok(found[0].includes(String(value)), `names the bad value: ${found[0]}`);
  } else assert.deepEqual(found, [], String(value));
};

const saveCallers = (idx, file, className) => idx.callersOf({ file: path.join(root, file), className, name: 'save' }).map((c) => c.label);
const holder = (importLine, type, owner = 'Svc') => `${importLine} export class ${owner} { constructor(private repo: ${type}) {} run() { this.repo.save(); } }`;

module.exports = {
  ts, root, build, response, client, CONCURRENCY_CASES, assertConcurrencyWarnings, saveCallers, holder,
};
