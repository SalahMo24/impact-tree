'use strict';
const path = require('path');
const { throwIfCancelled, isAnalysisCancelled } = require('./cancellation');

// The configuration is optional: a preview's callers come from the PR's files whether
// or not a tsconfig or package.json was read. So once GitHub could not be reached (a
// connection failure or a request past its deadline), the remaining configuration files
// are not asked for: each would wait for the same failure, and the walk up a file's
// folders asks for one per level. One warning says how many were skipped. Owner: the
// preview that created it, shared by `remoteOptions` and `remotePackages` so the second
// does not pay again for what the first learnt; each makes its own when given none.
function createConnectionFuse(warnings) {
  let lost = null;
  let skipped = 0;
  return {
    /** @param {string} rel @param {() => Promise<string|null>} fetchOnce @returns {Promise<string|null>} */
    async fetch(rel, fetchOnce) {
      if (lost) { skipped++; return null; }
      try { return await fetchOnce(); } catch (e) {
        if (!isAnalysisCancelled(e) && (e.name === 'GitHubNetworkError' || e.name === 'GitHubTimeoutError')) lost = e;
        throw e;
      }
    },
    /** Adds the one warning for the files not asked for; nothing when none was skipped. */
    note() {
      if (skipped) warnings.push(`${skipped} configuration file(s) not fetched after GitHub could not be reached (${lost.message})`);
      skipped = 0;
    },
  };
}

// Read only configuration from the pinned PR head. Callers still come exclusively
// from PR files; a local checkout's tsconfig must never influence a remote preview.
async function remoteOptions(ts, gh, slug, headSha, root, files, warnings, signal, fuse = createConnectionFuse(warnings)) {
  const cache = new Map(), configs = new Map();
  const load = (rel) => {
    throwIfCancelled(signal);
    if (!cache.has(rel)) cache.set(rel, (async () => {
      let text;
      try { text = await fuse.fetch(rel, () => gh.fileAtRef(slug, rel, headSha, { signal })); }
      catch (e) { if (isAnalysisCancelled(e)) throw e; warnings.push(`${rel}: configuration unavailable — ${e.message}`); return null; }
      throwIfCancelled(signal);
      if (text == null) return null;
      const abs = path.join(root, rel);
      configs.set(abs, text);
      const parsed = ts.parseConfigFileTextToJson(abs, text);
      if (parsed.error) { warnings.push(`${rel}: invalid TypeScript configuration`); return null; }
      return parsed.config;
    })());
    return cache.get(rel);
  };
  const parents = async (rel, cfg, seen = new Set()) => {
    throwIfCancelled(signal);
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const ext of [].concat(cfg.extends || [])) {
      if (!ext.startsWith('.')) { warnings.push(`${rel}: package-based tsconfig extends '${ext}' unavailable in PR preview`); continue; }
      let next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ext));
      if (!next.endsWith('.json')) next += '.json';
      if (next.startsWith('../')) continue;
      const c = await load(next);
      if (c) await parents(next, c, seen);
      else warnings.push(`${rel}: extended configuration '${next}' unavailable`);
    }
  };
  const options = new Map();
  const parsedConfigs = new Map();
  // Fetch each directory once, with bounded parallelism even for large PRs.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      throwIfCancelled(signal);
      const file = files[cursor++];
      let dir = path.posix.dirname(file);
      for (;;) {
        const rel = path.posix.join(dir, 'tsconfig.json');
        const cfg = await load(rel);
        if (cfg) {
          if (!parsedConfigs.has(rel)) parsedConfigs.set(rel, (async () => {
            await parents(rel, cfg);
            const abs = path.join(root, rel);
            const parsed = ts.parseJsonConfigFileContent(cfg, {
              useCaseSensitiveFileNames: true, readDirectory: () => [],
              fileExists: (f) => configs.has(f), readFile: (f) => configs.get(f),
            }, path.dirname(abs), undefined, abs);
            return parsed.options;
          })());
          options.set(path.join(root, file), await parsedConfigs.get(rel));
          break;
        }
        if (dir === '.') break;
        dir = path.posix.dirname(dir);
      }
    }
  }));
  fuse.note();
  return options;
}
module.exports = { remoteOptions, createConnectionFuse };

// Ancestors of available PR sources are enough to identify packages containing those
// sources. Metadata is read at the same pinned head, never from the local checkout.
async function remotePackages(gh, slug, headSha, root, files, warnings, signal, fuse = createConnectionFuse(warnings)) {
  const paths = new Set();
  for (const file of files) {
    let dir = path.posix.dirname(file);
    for (;;) {
      paths.add(path.posix.join(dir, 'package.json'));
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
  }
  const entries = [...paths], packages = [];
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(8, entries.length)}, async () => {
    while (cursor < entries.length) {
      throwIfCancelled(signal);
      const file = entries[cursor++];
      try {
        const text = await fuse.fetch(file, () => gh.fileAtRef(slug, file, headSha, { signal }));
        throwIfCancelled(signal);
        if (text == null) continue;
        const data = JSON.parse(text);
        // An unnamed manifest still decides whether its `.ts` files are ES modules.
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) packages.push({ dir: path.join(root, path.posix.dirname(file)), data });
      } catch (e) { if (isAnalysisCancelled(e)) throw e; warnings.push(`${file}: package metadata unavailable — ${e.message}`); }
    }
  }));
  fuse.note();
  return packages;
}
module.exports.remotePackages = remotePackages;
