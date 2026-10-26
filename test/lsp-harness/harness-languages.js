'use strict';

/**
 * The harness's stdio server services (./stdio-server-services.js: gopls, Pyright) as the
 * pipeline's `LanguageServices`
 * (src/languages/types.js), and a small caller resolver over them, so `analyze()` runs
 * against a real gopls or Pyright without the editor (`languageServices` and `makeResolver`).
 * Test code only. Head documents are read from disk; base documents are asked through a
 * temporary copy (stdio-server-services' `documentSymbols`). Nothing here turns a failure into
 * an empty answer: a rejection propagates, `null` stays `null`.
 */

const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { isTestFile } = require('../../src/engine/diff');
const { callersFromHierarchy, queryHierarchy, applyCallerExtras } = require('../../src/languages/callers-from-hierarchy');

/**
 * @param {ReturnType<typeof import('./stdio-server-services').createStdioServerServices>} server Started.
 * @param {{ repoRoot: string }} options Decides which callers are tests.
 * @returns {import('../../src/languages/types').LanguageServices}
 */
function languageServicesOver(server, { repoRoot }) {
  /** @param {{ file: string, side: 'head'|'base', text?: string }} doc */
  const withText = (doc) => {
    if (doc.side === 'base') {
      if (typeof doc.text !== 'string') throw new TypeError('a base-side document needs its text');
      return { file: doc.file, side: 'base', text: doc.text };
    }
    return { file: doc.file, side: 'head', text: doc.text ?? fs.readFileSync(doc.file, 'utf8') };
  };
  /** @param {{ file: string, side: string }} doc */
  const headOnly = (doc) => {
    if (doc.side !== 'head') return null;
    return withText(/** @type {any} */ (doc));
  };
  /** @param {{ uri: string, start: number, end: number }[]|null} locations */
  const toServerLocations = (locations) => (locations === null ? null
    : locations.map((l) => ({ file: fileURLToPath(l.uri), start: l.start, end: l.end })));
  return {
    available: (languageId) => server.available(languageId),
    documentSymbols: async (doc) => /** @type {any} */ (await server.documentSymbols(/** @type {any} */ (withText(/** @type {any} */ (doc))))),
    async prepareCallHierarchy(doc, pos) {
      const d = headOnly(doc);
      return d ? server.prepareCallHierarchy(/** @type {any} */ (d), pos) : null;
    },
    async incomingCalls(item) {
      const calls = await server.incomingCalls(/** @type {any} */ (item));
      if (calls === null) return null;
      return calls.map((c) => {
        const file = fileURLToPath(c.from.uri);
        return {
          label: c.from.name, file, pos: c.from.selectionRange.start, test: isTestFile(repoRoot, file),
          sites: c.fromRanges.length, callSites: c.fromRanges.map((r) => ({ start: r.start, end: r.end })),
        };
      });
    },
    async references(doc, pos) {
      const d = headOnly(doc);
      return d ? toServerLocations(await server.references(/** @type {any} */ (d), pos)) : null;
    },
    // LSP allows `null` for "no implementations", and gopls sends it for a method that
    // implements no interface. VS Code's executeImplementationProvider turns that into [],
    // which is what the editor's services see; the harness does the same, so `null` keeps
    // meaning "no answer" (G7: 139 methods read as unanswered before this).
    async implementations(doc, pos) {
      const d = headOnly(doc);
      if (!d) return null;
      return toServerLocations(await server.implementations(/** @type {any} */ (d), pos)) ?? [];
    },
    // `textDocument/definition` (Python's duck-typing check asks it; Go's extras do not).
    async definitions(doc, pos) {
      const d = headOnly(doc);
      return d ? toServerLocations(await server.definition(/** @type {any} */ (d), pos)) : null;
    },
  };
}

/**
 * A caller resolver (src/engine/caller-contract.js) over `services`, with the shared
 * default `callersFromHierarchy`: what the editor resolver does for a Go or Python target,
 * without its cache, cold phase or stats. `extras` (a language's `EditorCallerExtras`, such
 * as `goProvider.editorCallers(...)`) are applied by the same function the editor resolver
 * uses (`applyCallerExtras`, src/languages/callers-from-hierarchy.js). Suppressed queries
 * and unseen users are not applied (Go and Python have neither).
 * @param {import('../../src/languages/types').LanguageServices} services
 * @param {{ extras?: import('../../src/languages/types').EditorCallerExtras|null }} [options]
 */
function createHierarchyResolver(services, { extras = null } = {}) {
  /** @param {string} file */
  const headDoc = (file) => /** @type {import('../../src/languages/types').DocRef} */ ({ file, side: 'head' });
  /**
   * @param {string} file @param {number} pos @param {boolean} [withTests]
   * @returns {Promise<import('../../src/engine/caller-contract').CallerAnswer>}
   */
  const incomingWithStatus = async (file, pos, withTests = true) => {
    const query = extras ? extras.query(file, pos) : null;
    const retryRejected = extras?.retryRejected ?? null;
    const hierarchy = await queryHierarchy(services, headDoc(file), pos, { retryRejected });
    const applied = await applyCallerExtras(hierarchy, {
      extras, query, file, pos, withTests, askAt: (f, p) => queryHierarchy(services, headDoc(f), p, { retryRejected }),
    });
    if (applied.stale) throw new Error('harness: a query cannot be stale here (no clear())');
    return applied.answer;
  };
  return {
    kind: 'harness-callhierarchy',
    incomingWithStatus,
    /** @param {string} file @param {number} pos @param {boolean} [withTests] */
    incoming: async (file, pos, withTests = true) => (await incomingWithStatus(file, pos, withTests)).callers,
    /** @param {string} file @param {number} pos @param {{ isConstructor?: boolean }} [options] */
    callerState: (file, pos, { isConstructor = false } = {}) => callersFromHierarchy(services, {
      doc: headDoc(file), pos, isConstructor, incoming: () => incomingWithStatus(file, pos),
    }),
    dispose() {},
  };
}

module.exports = { languageServicesOver, createHierarchyResolver };
