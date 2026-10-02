'use strict';
const fs = require('fs');
const path = require('path');
const { worktreeFiles, isSourcePath, isTestFile, projectRootOf } = require('./diff');
const { createSyntacticIndex } = require('./syntactic-index');
const { createSyntacticResolver } = require('./resolver-syntactic');

// Bounds on the whole-repository index. Past them the search is incomplete and says so;
// a minified bundle or a vendored tree must not stall the editor.
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 1024 * 1024;

// A `require()` whose argument is not a string literal cannot be followed statically.
const COMPUTED_REQUIRE = /\brequire\s*\(\s*(?!['"`]|\))/;

/**
 * Callers in other files that the TypeScript language service cannot report, found by
 * the syntactic index over every source file in the worktree.
 *
 * It applies to a target file in exactly two cases, both properties of the file:
 * - `commonjs`: the file exports through `module.exports` / `exports.x`. TypeScript's
 *   call hierarchy does not follow `require()` back to the declaration.
 * - `no-config`: no tsconfig.json or jsconfig.json claims the file. The editor's
 *   inferred project holds only open files and their imports, so it cannot see
 *   callers in files that are not open.
 *
 * Scope: static `import` and string-literal `require()` forms, relative paths and
 * workspace package names. tsconfig `paths` and bundler aliases are not applied.
 *
 * @param {object} ts TypeScript module, used only to parse.
 * @param {string} repo Absolute repository root.
 * @param {{ raw: Function, tryRaw: Function }} git
 */
function createModuleCallers(ts, repo, git) {
  const kinds = new Map();          // abs file -> 'commonjs' | 'no-config' | null
  const hints = new Map();          // `${file}#${pos}` -> { className, name }
  let built = null;                 // { resolver, incomplete, computedRequires, indexed } once built

  function exportsCommonJs(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    if (!/\b(module\.)?exports\b/.test(text)) return false;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const isExportsTarget = (e) => (ts.isIdentifier(e) && e.text === 'exports')
      || (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)
        && e.expression.text === 'module' && e.name.text === 'exports');
    return sf.statements.some((st) => {
      if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) return false;
      if (st.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
      const left = st.expression.left;
      return isExportsTarget(left) || (ts.isPropertyAccessExpression(left) && isExportsTarget(left.expression));
    });
  }

  /** @returns {'commonjs'|'no-config'|null} Why this file needs the index, if it does. */
  function appliesTo(file) {
    if (kinds.has(file)) return kinds.get(file);
    const rel = path.relative(repo, file);
    let kind = null;
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && isSourcePath(rel)) {
      if (projectRootOf(repo, rel) === null) kind = 'no-config';
      else if (exportsCommonJs(file)) kind = 'commonjs';
    }
    kinds.set(file, kind);
    return kind;
  }

  function build() {
    if (built) return built;
    const listed = worktreeFiles(git);
    if (listed == null) {
      built = { resolver: null, incomplete: 'git could not list the repository files', computedRequires: 0, indexed: 0 };
      return built;
    }
    const sources = [];
    const packages = [];
    let skipped = 0;
    let computedRequires = 0;
    for (const rel of listed) {
      const abs = path.join(repo, rel);
      if (path.basename(rel) === 'package.json') {
        try {
          const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
          if (data && typeof data === 'object' && !Array.isArray(data)) packages.push({ dir: path.dirname(abs), data });
        } catch { /* not a manifest we can read; its package name stays unresolved */ }
        continue;
      }
      if (!isSourcePath(rel)) continue;
      if (sources.length >= MAX_FILES) { skipped++; continue; }
      let text;
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) { skipped++; continue; }
        text = fs.readFileSync(abs, 'utf8');
      } catch { continue; }   // listed by git but deleted in the worktree
      if (COMPUTED_REQUIRE.test(text)) computedRequires++;
      sources.push({ path: abs, text });
    }
    const idx = createSyntacticIndex(ts, sources, { baseDirs: [repo], packages });
    built = {
      resolver: createSyntacticResolver(idx, { isTestPath: (f) => isTestFile(repo, f), hints }),
      incomplete: skipped ? `${skipped} file(s) were not indexed (over ${MAX_FILES} files or ${MAX_FILE_BYTES / 1024} KB)` : null,
      computedRequires,
      indexed: sources.length,
    };
    return built;
  }

  /**
   * @returns {Promise<{callers: object[], complete: boolean, reason?: string}>}
   */
  async function incomingWithStatus(file, pos, withTests = true) {
    const { resolver, incomplete } = build();
    if (!resolver) return { callers: [], complete: false, reason: incomplete };
    const answer = await resolver.incomingWithStatus(file, pos, withTests);
    if (incomplete && answer.complete) return { ...answer, complete: false, reason: incomplete };
    return answer;
  }

  return {
    appliesTo,
    incomingWithStatus,
    /** Tell the index how the symbol collector anchors a changed symbol. */
    hint(c) {
      hints.set(`${c.file}#${c.namePos}`, {
        className: c.nested ? null : c.className || null,
        name: c.isConstructor ? 'constructor' : c.simpleName,
      });
    },
    /** Scope notes for the run, or `[]` when the index was never needed. */
    notes() {
      if (!built) return [];
      const out = [];
      if (built.incomplete) out.push(`cross-file callers may be missing: ${built.incomplete}`);
      if (built.computedRequires) {
        out.push(`${built.computedRequires} file(s) call require() with a computed path — callers through those calls are not seen`);
      }
      return out;
    },
  };
}

const callerId = (c) => `${c.file}#${c.pos}`;
function mergeCallers(a, b) {
  const seen = new Set(a.map(callerId));
  return a.concat(b.filter((c) => !seen.has(callerId(c))));
}

/**
 * Add `moduleCallers` answers to every query `resolver` answers for a file it applies
 * to. Callers both report are kept once, with the language service's row.
 * @returns {object} `resolver` with `incoming`, `incomingWithStatus` (when present) and
 *   `callerState` merged.
 */
function withModuleCallers(resolver, moduleCallers) {
  if (!moduleCallers) return resolver;
  const applies = (file) => moduleCallers.appliesTo(file) !== null;
  const wrapped = {
    ...resolver,
    incoming: async (file, pos, withTests = true) => {
      const own = await resolver.incoming(file, pos, withTests);
      if (!applies(file)) return own;
      return mergeCallers(own, (await moduleCallers.incomingWithStatus(file, pos, withTests)).callers);
    },
    callerState: async (file, pos, opts) => {
      const cs = await resolver.callerState(file, pos, opts);
      if (!applies(file)) return cs;
      const extra = await moduleCallers.incomingWithStatus(file, pos, true);
      const callers = mergeCallers(cs.callers, extra.callers);
      if (callers.length) return { ...cs, state: 'resolved', callers };
      // An empty answer from an unfinished search is not evidence that nothing calls it.
      if (!extra.complete) return { state: 'unknown', reason: extra.reason, callers: [] };
      return cs;
    },
  };
  if (resolver.incomingWithStatus) {
    wrapped.incomingWithStatus = async (file, pos, withTests = true) => {
      const own = await resolver.incomingWithStatus(file, pos, withTests);
      if (!applies(file)) return own;
      const extra = await moduleCallers.incomingWithStatus(file, pos, withTests);
      const callers = mergeCallers(own.callers, extra.callers);
      if (own.complete && extra.complete) return { callers, complete: true };
      return { callers, complete: false, reason: own.complete ? extra.reason : own.reason };
    };
  }
  return wrapped;
}

module.exports = { createModuleCallers, withModuleCallers };
