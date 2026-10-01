'use strict';
const fs = require('fs');
const path = require('path');
const { createInheritanceFilter } = require('./inheritance');
const { isTestFile } = require('./diff');
const { makeCqrsEdges } = require('./edges-cqrs');

// TS reports top-level/global-scope callers (a bare `it(...)` body) with the file path
// as the item name. Render something a human can read.
function labelOf(item) {
  const name = item.name && item.name.includes('/') ? path.basename(item.name) : item.name;
  return item.containerName ? `${item.containerName}.${name}` : name;
}

// Own-LanguageService resolver. Used by the CLI and by the deferred no-checkout PR mode.
// The extension uses resolver-vscode.js instead, which reuses the editor's TS server.
function createTsResolver(ts, componentDir, { tsconfig = 'tsconfig.json', testTsconfig = 'tsconfig.test.json', filterInherited = true, repoRoot = null, workspaceGraph = null, servicePool = null } = {}) {
  // Classified relative to the repo: an absolute path put every caller of a repo that
  // happens to live under some `.../tests/...` directory into the test bucket.
  const isTest = (f) => isTestFile(repoRoot || componentDir, f);
  const services = [];
  const prodServices = [];
  // A solution-style tsconfig (`"files": []` plus `references`, the Vite and Nx
  // default) compiles nothing itself; the code lives in the projects it references.
  const configsFrom = (full) => {
    const out = [];
    const seen = new Set();
    const walk = (cfgPath) => {
      if (seen.has(cfgPath) || !fs.existsSync(cfgPath)) return;
      seen.add(cfgPath);
      const raw = ts.readConfigFile(cfgPath, ts.sys.readFile);
      if (!raw.config) return;
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(cfgPath), undefined, cfgPath);
      if (parsed.fileNames.length || !(parsed.projectReferences || []).length) out.push(parsed);
      for (const ref of parsed.projectReferences || []) {
        const target = ts.resolveProjectReferencePath ? ts.resolveProjectReferencePath(ref) : ref.path;
        walk(fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'tsconfig.json') : target);
      }
    };
    walk(full);
    return out;
  };
  const consumers = repoRoot ? (workspaceGraph || require('./workspace-projects').workspaceProjects(ts, repoRoot)).consumers(componentDir) : [];
  const configPaths = [path.join(componentDir, tsconfig), path.join(componentDir, testTsconfig),
    ...consumers.flatMap(c => [c, path.join(path.dirname(c), testTsconfig)])];
  const loaded = new Set();
  for (const full of configPaths) {
    if (!fs.existsSync(full)) continue;
    for (const parsed of configsFrom(full)) {
      const configPath = parsed.options.configFilePath || full;
      if (loaded.has(configPath)) continue;
      loaded.add(configPath);
      const poolKey = `${ts.version}:${configPath}`;
      if (servicePool?.services.has(poolKey)) {
        const svc = servicePool.services.get(poolKey);
        services.push(svc);
        if (path.basename(full) !== testTsconfig) prodServices.push(svc);
        continue;
      }
      const files = parsed.fileNames;
      // Defect fix: a constant version made the service cache file contents forever —
      // correct for a batch run, wrong the moment anything edits a file.
      const versions = new Map();
      const versionOf = (f) => {
        try { const m = fs.statSync(f).mtimeMs; versions.set(f, String(m)); return String(m); }
        catch { return versions.get(f) || '0'; }
      };
      if (servicePool && !servicePool.registries.has(ts)) servicePool.registries.set(ts, ts.createDocumentRegistry());
      const svc = ts.createLanguageService({
        getScriptFileNames: () => files,
        getScriptVersion: versionOf,
        getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined),
        getCurrentDirectory: () => path.dirname(configPath),
        getCompilationSettings: () => parsed.options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        realpath: ts.sys.realpath, fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
      }, servicePool ? servicePool.registries.get(ts) : ts.createDocumentRegistry());
      servicePool?.services.set(poolKey, svc);
      services.push(svc);
      if (path.basename(full) !== testTsconfig) prodServices.push(svc);
    }
  }
  if (!services.length) return null;
  const inProgram = (file) => services.some((ls) => {
    try { return !!ls.getProgram().getSourceFile(file); } catch { return false; }
  });

  // definition/reference primitives the CQRS provider needs, backed by the same services
  const cqrs = makeCqrsEdges(ts, {
    isTestPath: isTest,
    async definitionAt(file, offset) {
      for (const ls of services) {
        let defs = [];
        try { defs = ls.getDefinitionAtPosition(file, offset) || []; } catch { defs = []; }
        const d = defs.find((x) => x.fileName && x.textSpan);
        if (d) return { file: d.fileName, offset: d.textSpan.start };
      }
      return null;
    },
    async referencesTo(file, offset) {
      const out = [];
      const seen = new Set();
      for (const ls of services) {
        let refs = [];
        try { refs = ls.findReferences(file, offset) || []; } catch { refs = []; }
        for (const r of refs) for (const x of r.references) {
          const id = `${x.fileName}#${x.textSpan.start}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({ file: x.fileName, offset: x.textSpan.start });
        }
      }
      return out;
    },
  });

  const cache = new Map();
  const stats = { incomingCalls: 0, incomingMs: 0, refCalls: 0, refMs: 0, cacheHits: 0, cqrsEdges: 0, inheritedDropped: 0 };
  // Same over-report the extension sees: both ask the TypeScript call hierarchy.
  const inherited = filterInherited ? createInheritanceFilter(ts) : null;
  // Each query is a project-wide findReferences, so cost scales with program size and
  // with how common the symbol name is (`execute`, `write`). Skipping the test program
  // on deep walks roughly halves it; the extension avoids this entirely by being lazy.
  function incomingSync(file, pos, withTests = true) {
    const key = `${withTests ? 'A' : 'P'}${file}#${pos}`;
    if (cache.has(key)) { stats.cacheHits++; return cache.get(key); }
    const t = Date.now();
    stats.incomingCalls++;
    const seen = new Map();
    const use = withTests ? services : prodServices;
    for (const ls of use) {
      let calls = [];
      try { calls = ls.provideCallHierarchyIncomingCalls(file, pos) || []; } catch { calls = []; }
      for (const c of calls) {
        const id = `${c.from.file}#${c.from.selectionSpan.start}`;
        if (!seen.has(id)) seen.set(id, {
          label: labelOf(c.from), file: c.from.file, pos: c.from.selectionSpan.start,
          test: isTest(c.from.file), sites: c.fromSpans.length,
          callSites: [],
        });
        const row = seen.get(id);
        for (const sp of c.fromSpans) if (!row.callSites.some(s => s.start === sp.start && s.end === sp.start + sp.length)) {
          row.callSites.push({ start: sp.start, end: sp.start + sp.length });
        }
        row.sites = row.callSites.length;
      }
    }
    let out = [...seen.values()];
    if (inherited && out.length) {
      const { kept, dropped } = inherited.filterAt(file, pos, out);
      stats.inheritedDropped += dropped;
      out = kept;
    }
    stats.incomingMs += Date.now() - t;
    cache.set(key, out);
    return out;
  }

  // Defect fix: a function passed as a value (`dataSource.transaction(fn)`) is referenced
  // but never *called*, so call hierarchy returns nothing. That is unknown, not uncovered.
  function referenceCount(file, pos) {
    const t = Date.now(); stats.refCalls++;
    let n = 0;
    for (const ls of services) {
      let refs = [];
      try { refs = ls.findReferences(file, pos) || []; } catch { refs = []; }
      for (const r of refs) n += r.references.filter((x) => !x.isDefinition).length;
    }
    stats.refMs += Date.now() - t;
    return n;
  }

  const cqrsCache = new Map();
  async function withCqrs(file, pos, withTests) {
    // for a handler's execute(), the interface-derived callers are all false positives
    const handler = cqrs.isHandlerExecute(file, pos);
    const base = handler ? [] : incomingSync(file, pos, withTests);
    const key = `${file}#${pos}`;
    let extra = cqrsCache.get(key);
    if (extra === undefined) {
      try { extra = await cqrs.extraCallers(file, pos); } catch { extra = []; }
      cqrsCache.set(key, extra);
      stats.cqrsEdges += extra.length;
    }
    if (!extra.length) return base;
    if (handler) stats.cqrsSuppressed = (stats.cqrsSuppressed || 0) + 1;
    const seen = new Set(base.map((c) => `${c.file}#${c.pos}`));
    const merged = base.slice();
    for (const e of extra) {
      if (seen.has(`${e.file}#${e.pos}`)) continue;
      if (!withTests && e.test) continue;
      merged.push(e);
    }
    return merged;
  }

  return {
    kind: 'typescript-languageservice',
    async incoming(file, pos, withTests = true) { return withCqrs(file, pos, withTests); },
    async callerState(file, pos, { isConstructor = false } = {}) {
      const callers = await withCqrs(file, pos, true);
      if (callers.length) return { state: 'resolved', callers };
      // No tsconfig includes this file, so no query could have found a caller. "none"
      // there claimed a function nobody calls; the truth is we did not look.
      if (!inProgram(file)) return { state: 'unknown', reason: 'not-in-program', callers: [] };
      // A constructor with no `new X()` site is instantiated by the DI container.
      if (isConstructor) return { state: 'di', callers: [] };
      return { state: referenceCount(file, pos) > 0 ? 'unknown' : 'none', callers: [] };
    },
    stats: () => stats,
    program: () => services[0].getProgram(),
    dispose() { if (servicePool) return; services.forEach((s) => s.dispose && s.dispose()); },
  };
}
module.exports = { createTsResolver };
