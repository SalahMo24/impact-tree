'use strict';
const fs = require('fs');
const path = require('path');
const { projectConfigIn } = require('./diff');
const { JSCONFIG_DEFAULTS } = require('./resolver-ts');

// One spelling per file: TypeScript reports real paths with `/` separators, while the
// repo may be opened through a symlink and, on Windows, with `\\` and any drive case.
// A path that does not exist (deleted, virtual) keeps its lexical form; any other
// failure to resolve it propagates rather than silently dropping the file.
function canonical(file) {
  let real = file;
  try { real = fs.realpathSync(file); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  const resolved = path.resolve(real);
  return path.sep === '\\' ? resolved.toLowerCase() : resolved;
}

// Reverse import edges let a query include consumers whose files did not change.
// This is rebuilt per analysis, so edits to imports/configuration cannot go stale.
function workspaceProjects(ts, repo) {
  const found = ts.sys.readDirectory(repo, ['.json'],
    ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'], ['**/tsconfig.json', '**/jsconfig.json']);
  // One project per directory, chosen the way the TypeScript server chooses it.
  const configs = found.filter(config => projectConfigIn(path.dirname(config)) === path.basename(config));
  const projects = configs.map(config => {
    const raw = ts.readConfigFile(config, ts.sys.readFile);
    const existing = path.basename(config) === 'jsconfig.json' ? JSCONFIG_DEFAULTS : undefined;
    const parsed = ts.parseJsonConfigFileContent(raw.config || {}, ts.sys, path.dirname(config), existing, config);
    return { config, dir: path.dirname(config), parsed };
  }).sort((a,b) => b.dir.length - a.dir.length);
  // Files repeat across projects and imports, so each is resolved against the disk once per build.
  const spelled = new Map();
  const canon = file => { if (!spelled.has(file)) spelled.set(file, canonical(file)); return spelled.get(file); };
  for (const p of projects) p.prefix = canon(p.dir) + path.sep;
  const owner = file => { const c = canon(file); return projects.find(p => c.startsWith(p.prefix)); };
  const reverse = new Map(projects.map(p => [p.config, new Set()]));
  const edge = (consumer, file) => {
    const dependency = owner(file);
    if (dependency && dependency !== consumer) reverse.get(dependency.config).add(consumer.config);
  };
  for (const p of projects) {
    const configs = [p.parsed];
    const testConfig = path.join(p.dir, 'tsconfig.test.json');
    if (fs.existsSync(testConfig)) {
      const raw = ts.readConfigFile(testConfig, ts.sys.readFile);
      if (raw.config) configs.push(ts.parseJsonConfigFileContent(raw.config, ts.sys, p.dir, undefined, testConfig));
    }
    for (const parsed of configs) {
      const cache = ts.createModuleResolutionCache(repo, s => s, parsed.options);
      for (const file of parsed.fileNames) {
        edge(p, file);
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const imp of ts.preProcessFile(text, true, true).importedFiles) {
          const resolved = ts.resolveModuleName(imp.fileName, file, parsed.options, ts.sys, cache).resolvedModule;
          if (resolved) edge(p, resolved.resolvedFileName);
        }
      }
      for (const ref of parsed.projectReferences || []) {
        const target = ts.resolveProjectReferencePath(ref);
        if (reverse.has(target)) reverse.get(target).add(p.config);
      }
    }
  }
  return {
    /** @param {string} start Absolute path of the project's config file. */
    consumers(start) {
      const seen = new Set([start]), queue = [start];
      for (let i = 0; i < queue.length; i++) for (const next of reverse.get(queue[i]) || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
      return queue.slice(1);
    },
  };
}
module.exports = { workspaceProjects };
