'use strict';
const path = require('path');

// Read only configuration from the pinned PR head. Callers still come exclusively
// from PR files; a local checkout's tsconfig must never influence a remote preview.
async function remoteOptions(ts, gh, slug, headSha, root, files, warnings, signal) {
  const cache = new Map(), configs = new Map();
  const load = (rel) => {
    if (!cache.has(rel)) cache.set(rel, (async () => {
      let text;
      try { text = await gh.fileAtRef(slug, rel, headSha, { signal }); }
      catch (e) { warnings.push(`${rel}: configuration unavailable — ${e.message}`); return null; }
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
  return options;
}
module.exports = { remoteOptions };

// Ancestors of available PR sources are enough to identify packages containing those
// sources. Metadata is read at the same pinned head, never from the local checkout.
async function remotePackages(gh, slug, headSha, root, files, warnings, signal) {
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
      const file = entries[cursor++];
      try {
        const text = await gh.fileAtRef(slug, file, headSha, { signal });
        if (text == null) continue;
        const data = JSON.parse(text);
        // An unnamed manifest still decides whether its `.ts` files are ES modules.
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) packages.push({ dir: path.join(root, path.posix.dirname(file)), data });
      } catch (e) { warnings.push(`${file}: package metadata unavailable — ${e.message}`); }
    }
  }));
  return packages;
}
module.exports.remotePackages = remotePackages;
