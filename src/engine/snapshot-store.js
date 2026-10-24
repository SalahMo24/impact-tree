// @ts-check
'use strict';
const { realClock } = require('./clock');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeGit } = require('./git');
const { createDiffIndex, EXCLUDE_OWN_FOLDER } = require('./diff-index');

/**
 * @typedef {{ id: string, sha: string, objectsDir: string, createdAtMs: number,
 *   branch: string|null, headSha: string|null, round: number|null, bytes: number }} SnapshotRecord
 * `objectsDir` is absolute; `round` is set when Send feedback took the snapshot.
 */

const MANIFEST_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60000;
/** A temporary entry this old is a leftover: a take or a diff index lives for seconds. */
const TEMP_STALE_MS = 10 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Impact Tree', GIT_AUTHOR_EMAIL: 'impact-tree@localhost',
  GIT_COMMITTER_NAME: 'Impact Tree', GIT_COMMITTER_EMAIL: 'impact-tree@localhost',
};

/**
 * Total size in bytes of the files under `dir` (links are not followed). Walks the whole
 * folder: a snapshot only holds the objects the repository did not already have.
 * @param {string} dir
 * @returns {number}
 */
function directoryBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else total += fs.lstatSync(full).size;
  }
  return total;
}

/**
 * Pure check of one stored record. Nothing is repaired: a record that does not fit is
 * reported and skipped by the caller.
 * @param {unknown} value
 * @param {string} root
 * @returns {{ record: SnapshotRecord } | { problem: string }}
 */
function validateRecord(value, root) {
  if (!value || typeof value !== 'object') return { problem: 'not an object' };
  const r = /** @type {Record<string, unknown>} */ (value);
  if (typeof r.id !== 'string' || !ID_PATTERN.test(r.id)) return { problem: 'bad id' };
  if (typeof r.sha !== 'string' || !SHA_PATTERN.test(r.sha)) return { problem: 'bad sha' };
  if (r.objectsDir !== path.join(root, 'snapshots', r.id, 'objects')) return { problem: 'objectsDir is not this store\'s folder for the id' };
  if (typeof r.createdAtMs !== 'number' || !Number.isFinite(r.createdAtMs)) return { problem: 'bad createdAtMs' };
  if (r.branch !== null && typeof r.branch !== 'string') return { problem: 'bad branch' };
  if (r.headSha !== null && (typeof r.headSha !== 'string' || !SHA_PATTERN.test(r.headSha))) return { problem: 'bad headSha' };
  if (r.round !== null && !(Number.isInteger(r.round) && /** @type {number} */ (r.round) >= 0)) return { problem: 'bad round' };
  if (typeof r.bytes !== 'number' || !Number.isFinite(r.bytes) || r.bytes < 0) return { problem: 'bad bytes' };
  return {
    record: {
      id: r.id, sha: r.sha, objectsDir: r.objectsDir, createdAtMs: r.createdAtMs,
      branch: /** @type {string|null} */ (r.branch), headSha: /** @type {string|null} */ (r.headSha),
      round: /** @type {number|null} */ (r.round), bytes: r.bytes,
    },
  };
}

/**
 * Snapshots of the working tree, kept in a folder the extension owns. Git objects are
 * written only under `<root>/snapshots/<id>/objects`; the repository's `.git` is read,
 * never written.
 *
 * Layout: `<root>/manifest.json` (`{ version: 1, snapshots }`), `<root>/snapshots/<id>/objects`,
 * `<root>/tmp/`. Owner: the extension activation that created the store. Retention: none here
 * (the cleanup policy removes records through `remove`).
 *
 * @param {{ root: string, repo: string, log?: (message: string) => void, timeoutMs?: number, now?: () => number }} options
 *   `root` absolute folder we own; `repo` the repository root; `log` receives validation problems;
 *   `now` (epoch milliseconds; omitted: Date.now) dates snapshots and the temp sweep.
 * @returns {{
 *   take: (options?: { round?: number|null }) => Promise<SnapshotRecord>,
 *   list: () => SnapshotRecord[],
 *   find: (sha: string) => SnapshotRecord|null,
 *   remove: (id: string) => Promise<boolean>,
 *   objectDirs: () => string[],
 *   sweepTemp: () => Promise<void>,
 *   withDiffIndex: <T>(fn: (env: Record<string, string>) => T | Promise<T>) => Promise<T>,
 *   tempDir: () => string,
 * }}
 */
function createSnapshotStore({ root, repo, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, now = realClock.now }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError(`snapshot store root must be an absolute path, got ${JSON.stringify(root)}`);
  const manifestFile = path.join(root, 'manifest.json');
  const snapshotsDir = path.join(root, 'snapshots');
  const tmpDir = path.join(root, 'tmp');
  const git = makeGit(repo);

  // Writers (take, remove, sweepTemp) run one at a time through this chain, so two
  // read-modify-write cycles of the manifest cannot interleave. Owner: this store.
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  const serialized = (job) => {
    const run = queue.then(job);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  // Problems already reported, so a list() on every repaint does not repeat them.
  const reported = new Set();
  /** @param {string} key @param {string} message */
  const reportOnce = (key, message) => {
    if (reported.has(key)) return;
    reported.add(key);
    log(message);
  };

  /** @returns {SnapshotRecord[]} */
  function readManifest() {
    let text;
    try {
      text = fs.readFileSync(manifestFile, 'utf8');
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') reportOnce('manifest:read', `snapshots: cannot read ${manifestFile} (${/** @type {Error} */ (e).message}); treating it as empty`);
      return [];
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      reportOnce(`manifest:parse:${text.length}`, `snapshots: ${manifestFile} is not valid JSON; treating it as empty`);
      return [];
    }
    if (!data || typeof data !== 'object' || data.version !== MANIFEST_VERSION || !Array.isArray(data.snapshots)) {
      reportOnce(`manifest:version:${text.length}`, `snapshots: ${manifestFile} has an unknown format or version; treating it as empty`);
      return [];
    }
    const records = [];
    for (const item of data.snapshots) {
      const checked = validateRecord(item, root);
      if ('record' in checked) records.push(checked.record);
      else reportOnce(`record:${JSON.stringify(item && item.id)}:${checked.problem}`, `snapshots: skipping a stored snapshot (${checked.problem})`);
    }
    return records;
  }

  /** Atomic: a reader sees the old manifest or the new one, never half of it. @param {SnapshotRecord[]} snapshots */
  function writeManifest(snapshots) {
    fs.mkdirSync(root, { recursive: true });
    const temp = `${manifestFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: MANIFEST_VERSION, snapshots }, null, 2));
      fs.renameSync(temp, manifestFile);
    } catch (e) {
      fs.rmSync(temp, { force: true });
      throw e;
    }
  }

  const list = () => readManifest();
  /** @param {string} sha */
  const find = (sha) => readManifest().find((r) => r.sha === sha) || null;
  const objectDirs = () => readManifest().filter((r) => fs.existsSync(r.objectsDir)).map((r) => r.objectsDir);

  /** @param {{ round?: number|null }} options @returns {Promise<SnapshotRecord>} */
  async function doTake({ round = null }) {
    const id = `${now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const objectsDir = path.join(snapshotsDir, id, 'objects');
    fs.mkdirSync(objectsDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const work = fs.mkdtempSync(path.join(tmpDir, 'take-'));
    try {
      const repoObjects = (await git.rawAsync(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { timeoutMs })).trim();
      const realIndex = (await git.rawAsync(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { timeoutMs })).trim();
      const indexFile = path.join(work, 'index');
      if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, indexFile);   // no index yet: start empty
      const env = {
        GIT_OPTIONAL_LOCKS: '0', GIT_INDEX_FILE: indexFile, GIT_OBJECT_DIRECTORY: objectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjects, ...IDENTITY,
      };
      await git.rawAsync(['add', '-A', '--', '.', EXCLUDE_OWN_FOLDER], { timeoutMs, env });
      const tree = (await git.rawAsync(['write-tree'], { timeoutMs, env })).trim();
      const headSha = (await git.rawAsync(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs }).catch(() => '')).trim() || null;
      const sha = (await git.rawAsync(
        ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(headSha ? ['-p', headSha] : []), '-m', 'impact-tree snapshot'],
        { timeoutMs, env },
      )).trim();
      if (!SHA_PATTERN.test(sha)) throw new Error(`git commit-tree returned ${JSON.stringify(sha.slice(0, 80))}`);
      const branch = (await git.rawAsync(['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs }).catch(() => '')).trim() || null;
      /** @type {SnapshotRecord} */
      const record = { id, sha, objectsDir, createdAtMs: now(), branch, headSha, round, bytes: directoryBytes(path.join(snapshotsDir, id)) };
      writeManifest([...readManifest(), record]);
      return record;
    } catch (e) {
      fs.rmSync(path.join(snapshotsDir, id), { recursive: true, force: true });   // half-written: not in the manifest, not on disk
      throw e;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  return {
    /**
     * Records the working tree (tracked, modified, staged and untracked files; ignored files
     * and `.impact-tree/` excluded) as a commit. Calls run one after another.
     * @param {{ round?: number|null }} [options] `round` when Send feedback takes it.
     * @returns {Promise<SnapshotRecord>}
     * @throws {Error} Git failed or timed out; nothing is left in the store.
     */
    take: (options = {}) => serialized(() => doTake(options)),
    /** @returns {SnapshotRecord[]} Valid records; an unreadable manifest gives `[]` and one log line. */
    list,
    /** @param {string} sha @returns {SnapshotRecord|null} */
    find,
    /**
     * Deletes the snapshot's folder and manifest entry.
     * @param {string} id
     * @returns {Promise<boolean>} Whether a record was removed.
     */
    remove: (id) => serialized(async () => {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false;
      const all = readManifest();
      const kept = all.filter((r) => r.id !== id);
      const existed = kept.length !== all.length;
      if (existed) writeManifest(kept);
      fs.rmSync(path.join(snapshotsDir, id), { recursive: true, force: true });
      return existed;
    }),
    /** @returns {string[]} Absolute objects dirs of listed snapshots whose folder exists. */
    objectDirs,
    /**
     * Removes leftovers of an interrupted run from `<root>/tmp`. Call once at startup. Only
     * entries older than `TEMP_STALE_MS` go: an analysis started at launch (or in another
     * window on this workspace) may be using a newer one, and nothing waits on it here.
     * @param {{ nowMs?: number }} [options]
     * @returns {Promise<void>}
     */
    sweepTemp: ({ nowMs = now() } = {}) => serialized(async () => {
      let names;
      try { names = fs.readdirSync(tmpDir); } catch { return; }
      for (const name of names) {
        const full = path.join(tmpDir, name);
        let stat;
        try { stat = fs.lstatSync(full); } catch { continue; }
        if (nowMs - stat.mtimeMs > TEMP_STALE_MS) fs.rmSync(full, { recursive: true, force: true });
      }
    }),
    /**
     * Runs `fn` with the environment of a temporary intent-to-add index (see `createDiffIndex`),
     * and removes the index afterwards whatever `fn` does.
     * @template T
     * @param {(env: Record<string, string>) => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    withDiffIndex: async (fn) => {
      fs.mkdirSync(tmpDir, { recursive: true });
      const index = createDiffIndex(repo, { tempDir: tmpDir });
      try { return await fn(index.env); } finally { index.dispose(); }
    },
    /** @returns {string} Absolute folder for per-run temporary indexes; created if missing. */
    tempDir: () => { fs.mkdirSync(tmpDir, { recursive: true }); return tmpDir; },
  };
}

module.exports = { createSnapshotStore, validateRecord, TEMP_STALE_MS };
