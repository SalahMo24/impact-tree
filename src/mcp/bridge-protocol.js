// @ts-check
'use strict';
// What the editor's agent bridge (src/agent/agent-bridge.js) and the MCP server's client
// (src/mcp/bridge-client.js) agree on: where the per-repository lock file lives, what it
// holds, how a request line looks, and the bounds on all of it. Local only: a Unix socket
// (a named pipe on Windows) in a private temp directory, reachable by this user alone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOCK_VERSION = 1;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_CONNECTIONS = 4;
const METHODS = ['context', 'submit'];
const KINDS = ['cards', 'callers'];

/** @returns {string} The default directory of lock files and sockets. */
const defaultLockDir = () => path.join(os.tmpdir(), 'impact-tree-bridge');

/** @param {string} repo @returns {string} The real path of `repo`, or `repo` itself when it cannot be resolved. */
function realRepo(repo) {
  try { return fs.realpathSync(repo); } catch { return repo; }
}

/** @param {string} realPath @returns {string} 16 hex digits naming a repository's lock. */
const repoHash = (realPath) => crypto.createHash('sha256').update(realPath).digest('hex').slice(0, 16);

/** @param {string} dir @param {string} realPath @returns {string} */
const lockPathFor = (dir, realPath) => path.join(dir, `${repoHash(realPath)}.json`);

/**
 * Whether `pid` names a live process (this user's, or one we may signal).
 * @param {number} pid @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

/**
 * @typedef {{ version: 1, pid: number, repo: string, socket: string, token: string, startedAt: number, askedAt?: number }} Lock
 *   `askedAt`: when the user last pressed "Analyse with my agent" in that window (ms since the epoch).
 */

/**
 * Validates parsed lock-file content (a boundary: the file is on disk, written by another process).
 * @param {unknown} value
 * @returns {Lock|null} The lock, or null when any field is missing or of the wrong type.
 */
function parseLock(value) {
  if (!value || typeof value !== 'object') return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (v.version !== LOCK_VERSION) return null;
  if (typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid) || v.pid < 1) return null;
  if (typeof v.repo !== 'string' || v.repo === '' || v.repo.length > 4096) return null;
  if (typeof v.socket !== 'string' || v.socket === '' || v.socket.length > 4096) return null;
  if (typeof v.token !== 'string' || !/^[0-9a-f]{64}$/.test(v.token)) return null;
  if (typeof v.startedAt !== 'number' || !Number.isFinite(v.startedAt)) return null;
  if (v.askedAt !== undefined && (typeof v.askedAt !== 'number' || !Number.isFinite(v.askedAt))) return null;
  return { version: 1, pid: v.pid, repo: v.repo, socket: v.socket, token: v.token, startedAt: v.startedAt,
    ...(typeof v.askedAt === 'number' ? { askedAt: v.askedAt } : {}) };
}

/**
 * Reads the lock file of `realPath` in `dir`.
 * @param {string} dir @param {string} realPath
 * @returns {Lock|null} Null when it is missing, unreadable, larger than 64 KB, or malformed.
 */
function readLock(dir, realPath) {
  const file = lockPathFor(dir, realPath);
  try {
    if (fs.statSync(file).size > 64 * 1024) return null;
    return parseLock(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * JSON with object keys sorted at every depth, so equal payloads give equal text.
 * @param {unknown} value @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      /** @type {Record<string, unknown>} */
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

module.exports = { LOCK_VERSION, MAX_LINE_BYTES, MAX_PAYLOAD_BYTES, MAX_CONNECTIONS, METHODS, KINDS,
  defaultLockDir, realRepo, repoHash, lockPathFor, pidAlive, parseLock, readLock, canonicalJson };
