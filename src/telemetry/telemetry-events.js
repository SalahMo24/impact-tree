'use strict';
// Builds the properties of the `analysis.finished` event from a result: counts, the mode,
// the source kind and how many changed symbols are in each language. Never a path or a name.

const LANGUAGE_OF_EXT = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.go': 'go', '.py': 'py', '.pyi': 'py', '.java': 'java',
};

/**
 * @param {any} result An analysis result (local or preview).
 * @param {{ source: string, durationMs: number }} o `source`: 'local', 'checkout' or 'pr'.
 * @returns {Record<string, string|number|boolean>}
 */
function analysisFinishedProps(result, { source, durationMs }) {
  /** @type {Record<string, number>} */
  const langs = {};
  for (const c of (result && result.allChanged) || []) {
    const rel = typeof c.relPath === 'string' ? c.relPath : '';
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    const lang = LANGUAGE_OF_EXT[ext] || 'other';
    langs[`lang.${lang}`] = (langs[`lang.${lang}`] || 0) + 1;
  }
  const findings = (result && result.findings) || [];
  return {
    source,
    mode: String((result && result.mode) || 'unknown'),
    files: Number((result && result.changedFileCount) || 0),
    symbols: ((result && result.allChanged) || []).length,
    findings: findings.length,
    staleCallers: findings.reduce((n, f) => n + (Number(f.staleCallers) || 0), 0),
    warnings: ((result && result.warnings) || []).length,
    durationMs: Math.round(durationMs),
    ...langs,
  };
}

module.exports = { analysisFinishedProps };
