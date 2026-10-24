'use strict';

/**
 * G0 spike: what gopls gives us on cli/cli, answered through the harness.
 *
 *   node test/lsp-harness/g0-spike.js <path-to-cli-clone> [--gopls /path/to/gopls]
 *
 * Reads files in the clone and writes one scratch file under internal/config/ (removed
 * on exit). Never runs the clone's scripts. Prints a report to stdout; progress goes to
 * stderr. The whole run is bounded by OVERALL_DEADLINE_MS and gopls is killed on exit.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createGoplsServices } = require('./gopls-services');

const OVERALL_DEADLINE_MS = 14 * 60 * 1000;
const REQUEST_DEADLINE_MS = 5 * 60 * 1000;
const GIT_DEADLINE_MS = 20000;
const WARM_QUERIES = 10;
const BASE_REF = 'base-14752';
const SCRATCH_DIR_NAME = 'zz_it_scratch';

const report = [];
/** @param {string} line */
function say(line = '') { report.push(line); }
/** @param {string} line */
function progress(line) { process.stderr.write(`[g0 ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${line}\n`); }

const startedAt = Date.now();

/** @param {() => Promise<any>} fn @returns {Promise<{ ms: number, value?: any, error?: Error }>} */
async function timed(fn) {
  const t0 = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
  } catch (error) {
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, error };
  }
}

/** @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** @param {number} ms */
function fmt(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`; }

/** @param {string} cwd @param {string[]} args @returns {Promise<string>} */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_DEADLINE_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/** Offset of the first match's `name` group... the match of `nameRe` within `text`, at its start. */
function offsetOfName(text, re, name) {
  const m = re.exec(text);
  if (!m) throw new Error(`pattern ${re} not found`);
  return m.index + m[0].lastIndexOf(name);
}

/** @param {string} text @param {number} off */
function lineOf(text, off) { return text.slice(0, off).split('\n').length; }

/** @param {string} repo @param {string} uri */
function rel(repo, uri) {
  const p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  return p.startsWith(repo) ? p.slice(repo.length + 1) : p;
}

/** Runs one promise-returning step; a failure is reported and returned as `{ error }`. */
async function step(label, fn) {
  const r = await timed(fn);
  if (r.error) say(`  ! ${label}: ${r.error.message} (after ${fmt(r.ms)})`);
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith('--'));
  const gi = args.indexOf('--gopls');
  const goplsPath = gi >= 0 ? args[gi + 1] : path.join(os.homedir(), 'go', 'bin', 'gopls');
  if (!repo || !path.isAbsolute(repo)) throw new Error('usage: node g0-spike.js <absolute path to cli/cli clone> [--gopls path]');

  const goplsVersion = await new Promise((resolve, reject) => {
    execFile(goplsPath, ['version'], { timeout: GIT_DEADLINE_MS }, (e, out) => (e ? reject(e) : resolve(out.trim())));
  });
  const head = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  say(`# G0 spike measurements`);
  say(`machine: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0].model}, ${os.cpus().length} cpus, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB`);
  say(`gopls: ${goplsVersion.split('\n')[0]}; node ${process.version}; repo ${repo} @ ${head}`);
  say('');

  const events = [];
  const services = createGoplsServices({
    repo, goplsPath, deadlineMs: REQUEST_DEADLINE_MS,
    onNotification: (method, params) => {
      if (method === '$/progress' && params && params.value && (params.value.kind === 'begin' || params.value.kind === 'end')) {
        events.push({ t: Date.now() - startedAt, kind: params.value.kind, title: params.value.title || '', message: params.value.message || '' });
      }
    },
  });
  // gopls registers its progress token with window/workDoneProgress/create; the client
  // replies null by default (lsp-client), so nothing to do here.
  const scratch = path.join(repo, 'internal', 'config', SCRATCH_DIR_NAME);
  let tmpDir = null;
  const killTimer = setTimeout(() => { progress('overall deadline hit, killing gopls'); services.client.proc.kill('SIGKILL'); }, OVERALL_DEADLINE_MS);

  try {
    const tInit = await timed(() => services.start({ deadlineMs: 60000 }));
    if (tInit.error) throw tInit.error;
    progress(`initialized in ${fmt(tInit.ms)}`);

    const file = (p) => path.join(repo, p);
    const read = (p) => fs.readFileSync(file(p), 'utf8');
    const refreshPath = 'internal/config/refreshable.go';
    const refreshText = read(refreshPath);
    const refreshDoc = { file: file(refreshPath), text: refreshText };

    // ---- 5a. cold start --------------------------------------------------
    say('## 5. Timings, cold');
    say(`- spawn + initialize: ${fmt(tInit.ms)}`);
    const coldSyms = await timed(() => services.documentSymbols(refreshDoc));
    if (coldSyms.error) throw coldSyms.error;
    say(`- first documentSymbols (internal/config/refreshable.go, ${coldSyms.value.length} top-level symbols), since initialize returned: ${fmt(coldSyms.ms)}`);
    progress(`cold documentSymbols ${fmt(coldSyms.ms)}`);
    const simPos = offsetOfName(refreshText, /func simulateRefreshTokenExpired/, 'simulateRefreshTokenExpired');
    const coldPrep = await timed(() => services.prepareCallHierarchy(refreshDoc, simPos));
    if (coldPrep.error) throw coldPrep.error;
    say(`- first prepareCallHierarchy: ${fmt(coldPrep.ms)} -> ${coldPrep.value ? coldPrep.value.length : 'null'} item(s)`);
    const coldInc = await timed(() => services.incomingCalls(coldPrep.value[0]));
    if (coldInc.error) throw coldInc.error;
    say(`- first incomingCalls (simulateRefreshTokenExpired): ${fmt(coldInc.ms)} -> ${coldInc.value === null ? 'null' : coldInc.value.length} caller(s): ${(coldInc.value || []).map((c) => `${c.from.name} @${rel(repo, c.from.uri)}`).join(', ')}`);
    say(`- total, spawn to first incomingCalls answer: ${fmt(Date.now() - startedAt)}`);
    say(`- gopls progress: ${events.map((e) => `${e.kind} "${e.title || e.message}" at ${(e.t / 1000).toFixed(1)}s`).join('; ') || '(none reported)'}`);
    say('');

    // ---- 1. documentSymbols content ---------------------------------------
    say('## 1. documentSymbols on internal/config/refreshable.go');
    const syms = coldSyms.value;
    const kinds = {};
    for (const s of syms) kinds[s.kindName] = (kinds[s.kindName] || 0) + 1;
    say(`- top-level kinds: ${JSON.stringify(kinds)}`);
    const funcs = syms.filter((s) => s.kindName === 'Function' || s.kindName === 'Method');
    say(`- Function/Method symbols: ${funcs.length} (declared \`func\` lines in file: ${(refreshText.match(/^func /gm) || []).length})`);
    const startsWithFunc = funcs.filter((s) => refreshText.slice(s.range.start, s.range.start + 4) === 'func').length;
    const endsWithBrace = funcs.filter((s) => refreshText[s.range.end - 1] === '}').length;
    const selIsName = funcs.filter((s) => {
      const sel = refreshText.slice(s.selectionRange.start, s.selectionRange.end);
      return s.name === sel || s.name.endsWith(`.${sel}`);
    }).length;
    say(`- range starts at \`func\`: ${startsWithFunc}/${funcs.length}; range ends at closing \`}\`: ${endsWithBrace}/${funcs.length}`);
    const docCommentIncluded = funcs.filter((s) => /^\s*\/\//.test(refreshText.slice(refreshText.lastIndexOf('\n', s.range.start - 2) + 1, s.range.start))).length;
    say(`- range includes the leading doc comment: ${docCommentIncluded}/${funcs.length} (0 means it starts at \`func\`)`);
    say(`- selectionRange text equals the bare name (after the receiver prefix): ${selIsName}/${funcs.length}`);
    say('- examples (name | kind | detail | range lines | selectionRange text):');
    const sample = [funcs.find((s) => s.kindName === 'Function'), funcs.find((s) => s.kindName === 'Method'), funcs.find((s) => /\(\*AuthConfig\)\.loginRefreshable/.test(s.name))].filter(Boolean);
    for (const s of [...new Set(sample)]) {
      say(`    ${JSON.stringify(s.name)} | ${s.kindName} | detail=${JSON.stringify(s.detail)} | lines ${lineOf(refreshText, s.range.start)}-${lineOf(refreshText, s.range.end)} | sel=${JSON.stringify(refreshText.slice(s.selectionRange.start, s.selectionRange.end))}`);
    }
    const details = new Set(funcs.map((s) => s.detail));
    say(`- distinct \`detail\` values on functions/methods: ${[...details].slice(0, 5).map((d) => JSON.stringify(d)).join(', ')}${details.size > 5 ? ', ...' : ''} (${details.size} distinct)`);
    say(`- method names: ${funcs.filter((s) => s.kindName === 'Method').slice(0, 3).map((s) => JSON.stringify(s.name)).join(', ') || '(no Method kind)'}; kind of receiver methods: ${[...new Set(funcs.filter((s) => s.name.startsWith('(')).map((s) => s.kindName))].join(',') || 'n/a'}`);
    const withChildren = funcs.filter((s) => s.children.length > 0);
    say(`- functions with children: ${withChildren.length}; ${withChildren.slice(0, 3).map((s) => `${s.name} -> [${s.children.slice(0, 4).map((c) => `${c.kindName}:${c.name}`).join(', ')}]`).join('; ') || 'none'}`);
    const literals = (refreshText.match(/func\(/g) || []).length;
    say(`- function literals (\`func(\`) in file: ${literals}; appear as symbols: ${withChildren.some((s) => s.children.some((c) => /func|literal|\$/.test(c.name))) ? 'yes' : 'no (no child named like a literal)'}`);
    const otherKinds = syms.filter((s) => !['Function', 'Method'].includes(s.kindName)).slice(0, 6).map((s) => `${s.kindName}:${s.name}`);
    say(`- non-function symbols, e.g.: ${otherKinds.join(', ')}`);
    say('');

    // ---- 3. incomingCalls ---------------------------------------------------
    say('## 3. incomingCalls');
    /** @param {string} label @param {string} relPath @param {RegExp} re @param {string} name */
    async function callersOf(label, relPath, re, name) {
      const text = read(relPath);
      const doc = { file: file(relPath), text };
      const pos = offsetOfName(text, re, name);
      const prep = await step(`${label} prepare`, () => services.prepareCallHierarchy(doc, pos));
      if (prep.error) return null;
      if (!prep.value || prep.value.length === 0) {
        say(`- ${label}: prepareCallHierarchy -> ${prep.value === null ? 'null' : '[]'} (${fmt(prep.ms)})`);
        return { items: 0, callers: [] };
      }
      const inc = await step(`${label} incoming`, () => services.incomingCalls(prep.value[0]));
      if (inc.error) return null;
      const callers = inc.value || [];
      say(`- ${label}: ${inc.value === null ? 'null' : `${callers.length} caller(s)`} in ${fmt(inc.ms)} (+prepare ${fmt(prep.ms)}): ${callers.map((c) => `${c.from.name}@${rel(repo, c.from.uri)}`).join(', ')}`);
      return { items: prep.value.length, callers, pos };
    }

    await callersOf('simulateRefreshTokenExpired', refreshPath, /func simulateRefreshTokenExpired/, 'simulateRefreshTokenExpired');

    say('  Interface dispatch: (*AuthConfig).ActiveTokenWithRefresh implements gh.AuthConfig.ActiveTokenWithRefresh and api.refreshingConfig.ActiveTokenWithRefresh.');
    const apiCalls = fs.readFileSync(file('api/http_client.go'), 'utf8').split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('ActiveTokenWithRefresh(')).map(([n]) => `api/http_client.go:${n}`);
    const grepAll = await new Promise((resolve, reject) => {
      execFile('git', ['grep', '-n', 'ActiveTokenWithRefresh(', '--', '*.go'], { cwd: repo, timeout: GIT_DEADLINE_MS }, (e, out) => (e && e.code !== 1 ? reject(e) : resolve(out)));
    });
    say(`  textual call sites of the name (git grep, incl. definitions): ${grepAll.trim().split('\n').filter((l) => !/func /.test(l) && !l.includes('//')).map((l) => l.split(':').slice(0, 2).join(':')).join(', ')}`);
    say(`  (api/http_client.go lines with the name: ${apiCalls.join(', ')})`);
    const concrete = await callersOf('concrete (*AuthConfig).ActiveTokenWithRefresh [config.go]', 'internal/config/config.go', /func \(c \*AuthConfig\) ActiveTokenWithRefresh/, 'ActiveTokenWithRefresh');
    if (concrete) {
      const inTests = concrete.callers.filter((c) => c.from.uri.endsWith('_test.go'));
      say(`  -> callers in _test.go files: ${inTests.length} of ${concrete.callers.length}${inTests.length ? ` (e.g. ${inTests.slice(0, 2).map((c) => c.from.name + '@' + rel(repo, c.from.uri)).join(', ')})` : ''}`);
      say(`  -> callers in api/http_client.go (call is through the refreshingConfig interface): ${concrete.callers.filter((c) => rel(repo, c.from.uri) === 'api/http_client.go').length}`);
      const text = read('internal/config/config.go');
      const impl = await step('implementations from concrete', () => services.implementations({ file: file('internal/config/config.go'), text }, concrete.pos));
      say(`  -> implementations at the concrete method: ${impl.value === null || impl.error ? (impl.error ? 'error' : 'null') : impl.value.length} (${fmt(impl.ms)}): ${(impl.value || []).map((l) => rel(repo, l.uri)).join(', ')}`);
    }
    const iface = await callersOf('interface method gh.AuthConfig.ActiveTokenWithRefresh [gh.go]', 'internal/gh/gh.go', /\tActiveTokenWithRefresh\(hostname string\)/, 'ActiveTokenWithRefresh');
    if (iface) {
      const text = read('internal/gh/gh.go');
      const impl = await step('implementations from interface', () => services.implementations({ file: file('internal/gh/gh.go'), text }, iface.pos));
      say(`  -> implementations at the interface method: ${impl.error ? 'error' : impl.value === null ? 'null' : impl.value.length} (${fmt(impl.ms)}): ${(impl.value || []).slice(0, 8).map((l) => rel(repo, l.uri)).join(', ')}`);
    }
    // A test-only caller check on a function whose callers are mostly tests.
    await callersOf('accessTokenNeedsRefresh (has test callers in refreshable_test.go)', refreshPath, /func accessTokenNeedsRefresh/, 'accessTokenNeedsRefresh');

    say('  Build tags: internal/debug/config_disabled.go (//go:build !ghdebug) vs config_enabled.go (//go:build ghdebug); call sites: refreshable.go, factory/default.go.');
    await callersOf('debug.Config in config_disabled.go (active under default tags)', 'internal/debug/config_disabled.go', /func Config\(\)/, 'Config');
    await callersOf('debug.Config in config_enabled.go (excluded under default tags)', 'internal/debug/config_enabled.go', /func Config\(\)/, 'Config');
    const enabledText = read('internal/debug/config_enabled.go');
    const enabledSyms = await step('documentSymbols on config_enabled.go', () => services.documentSymbols({ file: file('internal/debug/config_enabled.go'), text: enabledText }));
    say(`  -> documentSymbols on the excluded-tag file: ${enabledSyms.error ? 'error' : enabledSyms.value === null ? 'null' : enabledSyms.value.length + ' symbol(s)'}`);
    say('');

    // ---- 4. references vs call hierarchy for value uses ---------------------
    say('## 4. references for a function used as a value');
    const commonText = read('pkg/cmd/codespace/common.go');
    const commonDoc = { file: file('pkg/cmd/codespace/common.go'), text: commonText };
    const naPos = offsetOfName(commonText, /func noArgsConstraint/, 'noArgsConstraint');
    const naPrep = await step('noArgsConstraint prepare', () => services.prepareCallHierarchy(commonDoc, naPos));
    const naInc = naPrep.value && naPrep.value.length ? await step('noArgsConstraint incoming', () => services.incomingCalls(naPrep.value[0])) : { value: null, ms: 0 };
    say(`- noArgsConstraint (cobra \`Args: noArgsConstraint\`, a value use): incomingCalls -> ${naInc.value === null ? 'null' : naInc.value.length} caller(s) (${fmt(naInc.ms)})`);
    const naRefs = await step('noArgsConstraint references', () => services.references(commonDoc, naPos));
    if (naRefs.value) {
      say(`- references -> ${naRefs.value.length} location(s) in ${fmt(naRefs.ms)}: ${naRefs.value.slice(0, 5).map((l) => `${rel(repo, l.uri)}:${lineOf(services.textOfUri(l.uri), l.start)}`).join(', ')}${naRefs.value.length > 5 ? ', ...' : ''}`);
      const textual = await new Promise((resolve, reject) => {
        execFile('git', ['grep', '-c', 'noArgsConstraint', '--', '*.go'], { cwd: repo, timeout: GIT_DEADLINE_MS }, (e, out) => (e && e.code !== 1 ? reject(e) : resolve(out)));
      });
      say(`- textual occurrences by \`git grep -c\` (files:count): ${textual.trim().split('\n').map((l) => l.replace('pkg/cmd/codespace/', '')).join(' ')}`);
    }
    const delText = read('pkg/cmd/gist/delete/delete.go');
    const delDoc = { file: file('pkg/cmd/gist/delete/delete.go'), text: delText };
    const delPos = offsetOfName(delText, /func deleteRun/, 'deleteRun');
    const delPrep = await step('deleteRun prepare', () => services.prepareCallHierarchy(delDoc, delPos));
    const delInc = delPrep.value && delPrep.value.length ? await step('deleteRun incoming', () => services.incomingCalls(delPrep.value[0])) : { value: null };
    const delRefs = await step('deleteRun references', () => services.references(delDoc, delPos));
    say(`- contrast, deleteRun (called inside the RunE closure; \`runF\` is a parameter, not a reference to deleteRun): incomingCalls -> ${delInc.value ? delInc.value.map((c) => c.from.name).join(',') : 'null'}; references -> ${delRefs.value ? delRefs.value.length : 'null'}`);
    say('');

    // ---- 5b. warm timings ----------------------------------------------------
    say('## 5. Timings, warm');
    const targets = funcs.slice(0, WARM_QUERIES);
    const prepT = []; const incT = []; const refT = []; const implT = [];
    for (const f of targets) {
      const pos = f.selectionRange.start;
      const p = await timed(() => services.prepareCallHierarchy(refreshDoc, pos));
      prepT.push(p.ms);
      if (p.value && p.value.length) incT.push((await timed(() => services.incomingCalls(p.value[0]))).ms);
      refT.push((await timed(() => services.references(refreshDoc, pos))).ms);
      implT.push((await timed(() => services.implementations(refreshDoc, pos))).ms);
    }
    const files10 = (await git(repo, ['ls-files', 'pkg/cmd/pr/**/*.go', 'internal/*/*.go'])).trim().split('\n').filter((f) => !f.endsWith('_test.go')).slice(0, 200);
    const symT = [];
    for (let i = 0; i < files10.length && symT.length < WARM_QUERIES; i += 17) {
      const t = read(files10[i]);
      const r = await timed(() => services.documentSymbols({ file: file(files10[i]), text: t }));
      if (!r.error) symT.push(r.ms);
    }
    const row = (name, xs) => say(`- ${name}: n=${xs.length}, median ${fmt(median(xs))}, min ${fmt(Math.min(...xs))}, max ${fmt(Math.max(...xs))}`);
    row('prepareCallHierarchy (functions in refreshable.go)', prepT);
    row('incomingCalls', incT);
    row('references', refT);
    row('implementations', implT);
    row('documentSymbols on first open of ~10 other files', symT);
    const reSyms = [];
    for (let i = 0; i < WARM_QUERIES; i++) reSyms.push((await timed(() => services.documentSymbols(refreshDoc))).ms);
    row('documentSymbols repeat on an already-open file', reSyms);
    say('');

    // ---- 2. base-side documents ---------------------------------------------
    say('## 2. Base-side documents (refreshable.go at ' + BASE_REF + ')');
    const baseText = await git(repo, ['show', `${BASE_REF}:${refreshPath}`]);
    const fnNames = (list) => new Set(list.filter((s) => s.kindName === 'Function' || s.kindName === 'Method').map((s) => s.name));
    const baseExpected = (baseText.match(/^func /gm) || []).length;
    say(`- base text: ${baseText.length} chars, ${baseExpected} \`func\` declarations (head has ${(refreshText.match(/^func /gm) || []).length})`);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-g0-'));
    fs.mkdirSync(scratch);
    const sameDirUntracked = path.join(scratch, 'refreshable.go');
    fs.writeFileSync(sameDirUntracked, baseText);
    fs.writeFileSync(path.join(tmpDir, 'refreshable.go'), baseText);
    const variants = [
      ['(a) virtual document impacttree-base:/internal/config/refreshable.go?ref=...', { uri: `impacttree-base:/${refreshPath}?ref=${BASE_REF}`, text: baseText }],
      ['(b) untitled:Untitled-1 (languageId go)', { uri: 'untitled:Untitled-1', text: baseText }],
      ['(c) temp file outside the module (os.tmpdir)', { file: path.join(tmpDir, 'refreshable.go'), text: baseText }],
      [`(d) same file name in ${SCRATCH_DIR_NAME}/ under the module`, { file: sameDirUntracked, text: baseText }],
    ];
    for (const [label, doc] of variants) {
      const r = await timed(() => services.documentSymbols(doc));
      if (r.error) { say(`- ${label}: ERROR ${r.error.message} (${fmt(r.ms)})`); continue; }
      if (r.value === null) { say(`- ${label}: null (${fmt(r.ms)})`); continue; }
      const names = fnNames(r.value);
      const gotKinds = {};
      for (const s of r.value) gotKinds[s.kindName] = (gotKinds[s.kindName] || 0) + 1;
      say(`- ${label}: ${r.value.length} symbols, ${names.size} functions/methods (expected ${baseExpected}), ${fmt(r.ms)}, kinds ${JSON.stringify(gotKinds)}`);
      if (doc.file || /^impacttree/.test(doc.uri)) {
        const p = await timed(() => services.prepareCallHierarchy(doc, r.value.find((s) => s.kindName === 'Function' || s.kindName === 'Method').selectionRange.start));
        say(`    prepareCallHierarchy on its first function: ${p.error ? 'ERROR ' + p.error.message : p.value === null ? 'null' : p.value.length + ' item(s)'} (${fmt(p.ms)})`);
      }
    }
    say('');
    say(`(total run time ${fmt(Date.now() - startedAt)}; gopls stderr tail: ${JSON.stringify(services.client.stderr.slice(-300))})`);
  } finally {
    clearTimeout(killTimer);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { progress(`could not remove ${scratch}: ${e.message}`); }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { progress(`could not remove ${tmpDir}: ${e.message}`); } }
    await services.close();
  }
}

main().then(() => {
  process.stdout.write(report.join('\n') + '\n');
  process.exit(0);
}).catch((err) => {
  process.stdout.write(report.join('\n') + '\n');
  process.stderr.write(`g0-spike failed: ${err.stack || err}\n`);
  process.exit(1);
});
