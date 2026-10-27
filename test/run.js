'use strict';
// Parallel test runner: `npm test` (full tier), `npm run test:quick`, `npm run test:serial`.
//
// Runs each file of the manifest (test/suite.js) as `node [--max-old-space-size=N] <file>` in its own
// child process with cwd = the repository root. Files are independent (each builds its own
// temporary repositories), so they run side by side; the longest known file starts first, using the
// durations the previous run left in test/.timings.json.
//
// Options:
//   --concurrency N   Child processes at once. Unit: processes. Default: max(1, min(6, CPUs / 2)).
//   --serial          Same as --concurrency 1.
//   --tier quick|full quick = the quick tier only; full = every file. Default: full.
//   --only SUBSTRING  Keep only manifest files whose path contains SUBSTRING (repeatable).
//   --file PATH       Run an ad-hoc file instead of the manifest (repeatable); it is not timed.
//   --deadline-s N    Wall-clock limit per file. Unit: seconds. Default: 120. On expiry the child's
//                     process group is killed and the file is reported HUNG.
//   --verbose         Print a failing file's whole output, not only its failing lines.
//
// Each child also gets --v8-pool-size=CHILD_V8_POOL_SIZE: V8 otherwise starts about one GC/compile
// helper thread per core in every child, and six children then oversubscribe the machine.
//
// On macOS, when `git` on PATH is Apple's /usr/bin/git shim (it runs xcrun on every call, ~20 ms
// each; a file starts hundreds of git processes), children get a PATH that starts with a
// private directory holding a link to the real binary that `xcrun -f git` names.
//
// Exit status: 0 all files passed; 1 a file failed, hung, or was killed by a signal;
// 2 bad usage, an unlisted test file, or nothing selected (a run that checks nothing fails).

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SUITE, checkCoverage } = require('./suite');

const REPO = path.resolve(__dirname, '..');
const TIMINGS_FILE = path.join(__dirname, '.timings.json');

/** Default per-file deadline. Unit: seconds. Exhaustion: the child is killed, the file is HUNG. */
const DEFAULT_DEADLINE_S = 120;
/**
 * V8 helper threads per child. Unit: threads. Measured on 12 cores: 8 children with the default pool
 * averaged a load of 175 and took 163 s; 6 children with 2 threads each, a load of 10 and 82 s.
 */
const CHILD_V8_POOL_SIZE = 2;
/** Most children the default allows. Unit: processes. */
const MAX_DEFAULT_CONCURRENCY = 6;
/** Upper bound on --concurrency. Unit: processes. Exhaustion: usage error. */
const MAX_CONCURRENCY = 64;
/**
 * Output kept per child. Unit: bytes. Exhaustion: the oldest output is dropped and the report says so;
 * the counts and failing lines come from the kept tail, which is where a test run prints them.
 */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
/** Failing lines shown per failed file without --verbose. Unit: lines. */
const MAX_FAIL_LINES = 20;
/** Interval between "still running" lines. Unit: ms. Keeps a quiet CI log from looking stuck. */
const HEARTBEAT_MS = 30000;
/** Grace between SIGTERM and SIGKILL when the runner itself is interrupted. Unit: ms. */
const INTERRUPT_GRACE_MS = 2000;

/** @returns {number} the default concurrency for this machine */
function defaultConcurrency() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(MAX_DEFAULT_CONCURRENCY, Math.floor(cpus / 2)));
}

/**
 * @param {string} name flag name, for the message
 * @param {string|undefined} text raw value
 * @param {number} max inclusive upper bound
 * @returns {number} a positive integer no greater than max
 */
function positiveInt(name, text, max) {
  const n = Number(text);
  if (text === undefined || !Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} needs an integer from 1 to ${max}, got ${JSON.stringify(text)}`);
  }
  return n;
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{concurrency:number, tier:'quick'|'full', only:string[], files:string[], deadlineS:number, verbose:boolean}}
 * @throws {Error} on an unknown flag or a bad value
 */
function parseArgs(argv) {
  const opts = { concurrency: defaultConcurrency(), tier: 'full', only: [], files: [], deadlineS: DEFAULT_DEADLINE_S, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--concurrency') opts.concurrency = positiveInt(flag, value(), MAX_CONCURRENCY);
    else if (flag === '--serial') opts.concurrency = 1;
    else if (flag === '--tier') {
      const tier = value();
      if (tier !== 'quick' && tier !== 'full') throw new Error(`--tier must be quick or full, got ${JSON.stringify(tier)}`);
      opts.tier = tier;
    } else if (flag === '--only') opts.only.push(value());
    else if (flag === '--file') opts.files.push(value());
    else if (flag === '--deadline-s') opts.deadlineS = positiveInt(flag, value(), 24 * 3600);
    else if (flag === '--verbose') opts.verbose = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return opts;
}

/**
 * Last durations, by manifest file. A missing file is normal (first run); an unreadable one is
 * reported and ignored so a corrupt cache cannot fail the suite.
 * @returns {Record<string, number>} seconds by file
 */
function readTimings() {
  let text;
  try {
    text = fs.readFileSync(TIMINGS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error(`warning: cannot read ${TIMINGS_FILE}: ${err.message}; scheduling in manifest order`);
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (err) {
    console.error(`warning: ${TIMINGS_FILE} is not valid (${err.message}); scheduling in manifest order`);
    return {};
  }
}

/**
 * Writes the timings atomically so a concurrent or interrupted run never leaves half a file.
 * A failure is reported but does not change the test verdict: timings are only a scheduling hint.
 * @param {Record<string, number>} timings seconds by file
 */
function writeTimings(timings) {
  const tmp = `${TIMINGS_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(timings, null, 2)}\n`);
    fs.renameSync(tmp, TIMINGS_FILE);
  } catch (err) {
    console.error(`warning: cannot write ${TIMINGS_FILE}: ${err.message}`);
  }
}

/**
 * Longest known first; files never timed go first (their cost is unknown), in manifest order.
 * @param {Array<{file:string}>} entries selected entries, in manifest order
 * @param {Record<string, number>} timings seconds by file
 * @returns {Array<{file:string}>} the run order
 */
function schedule(entries, timings) {
  const known = (e) => typeof timings[e.file] === 'number';
  const unknown = entries.filter((e) => !known(e));
  const timed = entries.filter(known).sort((a, b) => timings[b.file] - timings[a.file]);
  return [...unknown, ...timed];
}

/**
 * @param {string} output a child's captured output
 * @returns {{pass:number, fail:number}|null} node:test totals, or null for a plain script
 */
function tapCounts(output) {
  const pass = /^(?:# |ℹ )pass (\d+)\s*$/m.exec(output);
  const fail = /^(?:# |ℹ )fail (\d+)\s*$/m.exec(output);
  return pass && fail ? { pass: Number(pass[1]), fail: Number(fail[1]) } : null;
}

/**
 * @param {string} output a child's captured output
 * @returns {string[]} the lines that say what failed (not ok / Error / FAIL), at most MAX_FAIL_LINES
 */
function failingLines(output) {
  const lines = output.split('\n').filter((l) => /^\s*(not ok|✖)|Error|FAIL/.test(l));
  return lines.slice(0, MAX_FAIL_LINES);
}

/**
 * The environment for children. On macOS with the /usr/bin/git shim first on PATH: PATH led by a
 * temporary directory with `git` linked to the real binary, removed when the runner exits.
 * Anything else, or any failure to set it up: the runner's own environment, unchanged.
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv() {
  if (process.platform !== 'darwin') return process.env;
  try {
    const onPath = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
    if (onPath !== '/usr/bin/git') return process.env;
    const real = execFileSync('/usr/bin/xcrun', ['-f', 'git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!real || !fs.existsSync(real)) return process.env;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-tree-test-git-'));
    fs.symlinkSync(real, path.join(dir, 'git'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` };
  } catch {
    return process.env;
  }
}
/** @type {NodeJS.ProcessEnv|null} */
let childEnvCache = null;

/** Children alive now, so an interrupt of the runner can stop them. */
const live = new Set();

/**
 * @param {number} pid child pid
 * @param {NodeJS.Signals} signal signal to send to the child's process group (the child on Windows)
 */
function killTree(pid, signal) {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') console.error(`warning: cannot signal ${pid}: ${err.message}`);
  }
}

/**
 * Runs one file to completion, deadline or signal.
 * @param {{file:string, heapMb?:number}} entry what to run
 * @param {number} deadlineS per-file deadline, seconds
 * @returns {Promise<{file:string, status:'ok'|'FAIL'|'HUNG', secs:number, counts:{pass:number,fail:number}|null, output:string, truncated:boolean, note:string}>}
 */
function runFile(entry, deadlineS) {
  return new Promise((resolve) => {
    const args = [`--v8-pool-size=${CHILD_V8_POOL_SIZE}`];
    if (entry.heapMb) args.push(`--max-old-space-size=${entry.heapMb}`);
    args.push(entry.file);
    const started = Date.now();
    if (!childEnvCache) childEnvCache = childEnv();
    const child = spawn(process.execPath, args, { cwd: REPO, env: childEnvCache, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    live.add(child);
    let output = '';
    let truncated = false;
    let hung = false;
    let spawnError = null;
    const collect = (chunk) => {
      output += chunk;
      if (output.length > MAX_CAPTURE_BYTES) {
        output = output.slice(output.length - MAX_CAPTURE_BYTES);
        truncated = true;
      }
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const timer = setTimeout(() => {
      hung = true;
      killTree(child.pid, 'SIGKILL');
    }, deadlineS * 1000);
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      live.delete(child);
      const secs = (Date.now() - started) / 1000;
      const counts = tapCounts(output);
      let status = 'ok';
      let note = '';
      if (hung) {
        status = 'HUNG';
        note = `no exit within ${deadlineS}s deadline; killed`;
      } else if (spawnError) {
        status = 'FAIL';
        note = `could not start: ${spawnError.message}`;
      } else if (signal) {
        status = 'FAIL';
        note = `killed by ${signal}`;
      } else if (code !== 0) {
        status = 'FAIL';
        note = `exit code ${code}`;
      } else if (counts && counts.fail > 0) {
        status = 'FAIL';
        note = 'exit code 0 but the report has failures';
      }
      resolve({ file: entry.file, status, secs, counts, output, truncated, note });
    });
  });
}

/**
 * @param {{file:string,status:string,secs:number,counts:{pass:number,fail:number}|null,output:string,truncated:boolean,note:string}} r a finished file
 * @param {boolean} verbose whether to print the whole output of a failure
 */
function report(r, verbose) {
  const detail = r.counts ? `pass ${r.counts.pass} fail ${r.counts.fail}` : '(script)';
  console.log(`${r.status.padEnd(4)}  ${r.file}  ${detail}  ${r.secs.toFixed(1)}s`);
  if (r.status === 'ok') return;
  console.log(`      ${r.note}${r.truncated ? ' (output truncated to its last 8 MB)' : ''}`);
  const shown = verbose ? r.output.split('\n') : failingLines(r.output);
  for (const line of shown) console.log(`      | ${line}`);
  if (!verbose && shown.length === 0) {
    for (const line of r.output.split('\n').slice(-MAX_FAIL_LINES)) console.log(`      | ${line}`);
  }
}

/**
 * @param {Array<{file:string,heapMb?:number}>} order run order
 * @param {number} concurrency processes at once
 * @param {number} deadlineS per-file deadline, seconds
 * @param {boolean} verbose print whole output of failures
 * @returns {Promise<Array<object>>} every result, in completion order
 */
function runAll(order, concurrency, deadlineS, verbose) {
  return new Promise((resolve) => {
    const results = [];
    const running = new Set();
    let next = 0;
    const heartbeat = setInterval(() => {
      console.log(`... ${results.length}/${order.length} done, running: ${[...running].join(' ')}`);
    }, HEARTBEAT_MS);
    const pump = () => {
      while (running.size < concurrency && next < order.length) {
        const entry = order[next++];
        running.add(entry.file);
        runFile(entry, deadlineS).then((r) => {
          running.delete(entry.file);
          results.push(r);
          report(r, verbose);
          pump();
        });
      }
      if (running.size === 0 && next >= order.length) {
        clearInterval(heartbeat);
        resolve(results);
      }
    };
    pump();
  });
}

/** Stops every live child, then the runner, when interrupted. */
function installInterruptHandlers() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.error(`\n${sig}: stopping ${live.size} running file(s)`);
      for (const c of live) killTree(c.pid, 'SIGTERM');
      setTimeout(() => {
        for (const c of live) killTree(c.pid, 'SIGKILL');
        process.exit(130);
      }, INTERRUPT_GRACE_MS).unref();
    });
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`test/run.js: ${err.message}`);
    return 2;
  }

  const coverage = checkCoverage(__dirname);
  if (coverage.length > 0) {
    console.error('test/suite.js is out of date with the files in test/:');
    for (const problem of coverage) console.error(`  ${problem}`);
    return 2;
  }

  let entries;
  if (opts.files.length > 0) {
    entries = opts.files.map((file) => ({ file }));
  } else {
    entries = SUITE.filter((e) => opts.tier === 'full' || e.tier === 'quick');
    if (opts.only.length > 0) entries = entries.filter((e) => opts.only.some((s) => e.file.includes(s)));
  }
  if (entries.length === 0) {
    console.error('test/run.js: no test file selected; a run that checks nothing fails');
    return 2;
  }

  installInterruptHandlers();
  const timings = readTimings();
  const order = schedule(entries, timings);
  const concurrency = Math.min(opts.concurrency, order.length);
  console.log(`running ${order.length} file(s), ${concurrency} at a time, tier ${opts.files.length ? 'ad-hoc' : opts.tier}, deadline ${opts.deadlineS}s`);

  const started = Date.now();
  const results = await runAll(order, concurrency, opts.deadlineS, opts.verbose);
  const wall = (Date.now() - started) / 1000;

  const inManifest = new Set(SUITE.map((e) => e.file));
  const updated = readTimings();
  for (const r of results) {
    if (r.status !== 'HUNG' && inManifest.has(r.file)) updated[r.file] = Math.round(r.secs * 10) / 10;
  }
  writeTimings(updated);

  const bad = results.filter((r) => r.status !== 'ok');
  const cpu = results.reduce((sum, r) => sum + r.secs, 0);
  console.log(`\n${results.length} file(s), ${bad.length} failed, wall ${wall.toFixed(1)}s, child time ${cpu.toFixed(1)}s`);
  for (const r of bad) console.log(`  ${r.status} ${r.file}: ${r.note}`);
  return bad.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, schedule, tapCounts, failingLines };
