'use strict';
const fs = require('fs');
const path = require('path');

// Reverse import edges let a query include consumers whose files did not change.
// This is rebuilt per analysis, so edits to imports/configuration cannot go stale.
function workspaceProjects(ts, repo) {
  const configs = ts.sys.readDirectory(repo, ['.json'],
    ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'], ['**/tsconfig.json']);
  const projects = configs.map(config => {
    const raw = ts.readConfigFile(config, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(raw.config || {}, ts.sys, path.dirname(config), undefined, config);
    return { config, dir: path.dirname(config), parsed };
  }).sort((a,b) => b.dir.length - a.dir.length);
  const owner = file => projects.find(p => file.startsWith(p.dir + path.sep));
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
    consumers(componentDir) {
      const start = path.join(componentDir, 'tsconfig.json');
      const seen = new Set([start]), queue = [start];
      for (let i = 0; i < queue.length; i++) for (const next of reverse.get(queue[i]) || []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
      return queue.slice(1);
    },
  };
}
module.exports = { workspaceProjects };
