// @ts-check
'use strict';
/**
 * C# end to end through the editor's path (Part C, C5). A development script, not part of
 * `npm test`; run it through `npm run oracle` (the test-repository lock, the .NET SDK on PATH).
 *
 *   node test/lsp-harness/csharp-e2e.js --repo <C# clone, restored> --solution <.sln/.slnx> --base <sha> [--tools <dir>]
 *
 * One Roslyn (the MIT `roslyn-language-server`, ./roslyn-services.js; never the C# extension's
 * VSIX) loads the solution on the clone as it is checked out (nothing is checked out or
 * changed); then `analyze()` in `pr` mode against `--base` twice:
 *   1. the editor's path: C#'s `prepare` (the probe answered yes: Roslyn has loaded), callers
 *      from the call hierarchy with C#'s editor extras applied by `applyCallerExtras`
 *      (./harness-languages.js), the dispatch index built as the extension host builds it
 *      (`sessionIndex`, its time traced);
 *   2. the CLI's path: no language services, so `prepareSyntactic` (the syntax index).
 * Prints, per changed member: callers (labelled) and completeness on each path, the reasons
 * of the editor's incomplete answers, the timings, and Roslyn's query count and failures.
 */

const path = require('node:path');
const { createRoslynServices } = require('./roslyn-services');
const { languageServicesOver, createHierarchyResolver } = require('./harness-languages');

function args() {
  /** @type {Record<string, string>} */
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1];
  if (!out.repo || !out.solution || !out.base) {
    console.error('usage: csharp-e2e.js --repo <C# clone> --solution <.sln/.slnx> --base <sha> [--tools <dir>]');
    process.exit(2);
  }
  return out;
}

async function main() {
  const opt = args();
  const repo = path.resolve(opt.repo);
  const { analyze } = require('../../src/engine/analyze');
  const registry = require('../../src/languages');
  const { createCsharpProvider } = require('../../src/languages/csharp/provider');
  const csharp = createCsharpProvider({ probe: async () => ({ ok: true }) });
  const restore = registry.useLanguagesForTest(registry.registeredLanguages().map((l) => (l.id === 'csharp' ? csharp : l)));
  const t0 = Date.now();
  const server = createRoslynServices({ repo, solution: opt.solution, ...(opt.tools ? { tools: opt.tools } : {}) });
  const stats = { queries: 0, failures: /** @type {string[]} */ ([]) };
  try {
    const started = await server.start();
    console.log(`roslyn: initialize ${started.initializedMs} ms, projects loaded ${(started.loadedMs / 1000).toFixed(1)} s`);
    const base = languageServicesOver(/** @type {any} */ (server), { repoRoot: repo });
    /** @type {any} */
    const services = {
      ...base,
      async incomingCalls(/** @type {any} */ item) {
        stats.queries++;
        try { return await base.incomingCalls(item); } catch (e) { stats.failures.push(String(/** @type {any} */ (e).message).slice(0, 120)); throw e; }
      },
    };
    /** @type {string[]} */
    const traces = [];
    const e0 = Date.now();
    const editor = await analyze(repo, {
      mode: 'pr', base: opt.base, allowLocalBase: true, skipForest: true, deferTestReach: true, depth: 1,
      languageServices: services,
      makeResolver: ({ language }) => createHierarchyResolver(services, {
        extras: language === 'csharp' && csharp.editorCallers
          ? csharp.editorCallers({ ts: null, services, repoRoot: repo, trace: (m) => traces.push(m), filterInherited: false, onWarmupRetry: () => {} })
          : null,
      }),
    });
    const editorMs = Date.now() - e0;
    const s0 = Date.now();
    const syntax = await analyze(repo, { mode: 'pr', base: opt.base, allowLocalBase: true, skipForest: true, deferTestReach: true, depth: 1 });
    const syntaxMs = Date.now() - s0;
    for (const t of traces) console.log(`trace: ${t}`);
    console.log(`editor path ${(editorMs / 1000).toFixed(1)} s (incl. the index build), syntax path ${(syntaxMs / 1000).toFixed(1)} s; incomingCalls ${stats.queries}, failed ${stats.failures.length}`);
    for (const f of stats.failures) console.log(`  failure: ${f}`);
    for (const w of editor.warnings || []) console.log(`editor warning: ${w}`);
    /** @param {any} r */
    const byKey = (r) => new Map((r.findings || []).filter((/** @type {any} */ f) => /\.cs$/.test(f.relPath || f.file || '')).map((/** @type {any} */ f) => [`${f.relPath}#${f.key}`, f]));
    const E = byKey(editor);
    const S = byKey(syntax);
    /** @param {any} f */
    const names = (f) => new Set((f ? f.callers || [] : []).map((/** @type {any} */ c) => `${path.relative(repo, c.file)}#${c.label}`));
    const totals = { members: 0, editor: 0, syntax: 0, both: 0, labelled: 0, editorComplete: 0, syntaxComplete: 0 };
    for (const key of new Set([...E.keys(), ...S.keys()])) {
      const e = E.get(key);
      const s = S.get(key);
      const en = names(e);
      const sn = names(s);
      const both = [...en].filter((x) => sn.has(x)).length;
      const labelled = (e ? e.callers || [] : []).filter((/** @type {any} */ c) => c.via);
      totals.members++; totals.editor += en.size; totals.syntax += sn.size; totals.both += both; totals.labelled += labelled.length;
      if (e && e.callersComplete) totals.editorComplete++;
      if (s && s.callersComplete) totals.syntaxComplete++;
      console.log(`\n${key}`);
      console.log(`  editor: ${e ? `${e.callerState} ${en.size} caller(s), ${e.callersComplete ? 'complete' : 'incomplete'}` : 'not listed'} | syntax: ${s ? `${s.callerState} ${sn.size} caller(s), ${s.callersComplete ? 'complete' : 'incomplete'}` : 'not listed'} | both ${both}`);
      for (const c of labelled) console.log(`  labelled: ${c.label} (${c.text})`);
      for (const x of en) if (!sn.has(x)) console.log(`  editor only: ${x}`);
      for (const x of sn) if (!en.has(x)) console.log(`  syntax only: ${x}`);
      if (e && !e.callersComplete) console.log(`  editor reason: ${String(e.callersIncompleteReason).slice(0, 400)}`);
    }
    console.log(`\ntotals ${JSON.stringify(totals)}; wall ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    restore();
    await server.close().catch((e) => console.error(`closing roslyn: ${e.message}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
