'use strict';
// The per-file half of the analysis: given the two versions of a file and which lines
// the diff touched, work out which callables changed and how badly.
//
// Split out of analyze.js so the local path (git + disk) and the Tier A path (text
// fetched from the GitHub API) share one implementation. Everything here is pure --
// it never reads a file or shells out — so the caller decides where text comes from.
const { diffSignature, newThrows, KIND } = require('./signature');

// file: { absPath, relPath, status, headText, baseText, hunkRanges, component, projectRoot }
// hunkRanges: [[startLine, endLine], ...] 1-based, on the NEW side.
function changedSymbolsIn(ts, S, file) {
  const {
    absPath, relPath, status, headText, baseText, hunkRanges = [], component, projectRoot,
  } = file;

  const parse = (text) => {
    if (text == null) return null;
    try {
      return ts.createSourceFile(absPath, text, ts.ScriptTarget.ES2021, true,
        absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined);
    } catch { return null; }
  };

  const headSf = status === 'deleted' ? null : parse(headText);
  const baseSf = status === 'added' ? null : parse(baseText);

  const headCallables = headSf ? S.collect(headSf) : [];
  const baseCallables = baseSf ? S.collect(baseSf) : [];
  const baseByLabel = new Map(baseCallables.map((c) => [c.label, c]));
  const headLabels = new Set(headCallables.map((c) => c.label));

  const deleted = [];
  for (const b of baseCallables) {
    if (!headLabels.has(b.label)) {
      deleted.push({ ...b, file: absPath, relPath, component, projectRoot });
    }
  }

  const changed = [];
  if (headSf) {
    const picked = new Set();
    for (const [lo, hi] of hunkRanges) {
      const hit = S.mapHunk(headCallables, lo, hi);
      if (!hit || picked.has(hit.label)) continue;
      picked.add(hit.label);
      const b = baseByLabel.get(hit.label);
      const kinds = diffSignature(b, hit);
      const throwsAdded = newThrows(b, hit);
      if (throwsAdded.length) kinds.push(KIND.NEW_THROW);
      changed.push({
        ...hit,
        file: absPath, relPath, component, projectRoot, fileStatus: status,
        added: !b,
        baseSig: b ? S.renderSig(b.sig) : null,
        headSig: S.renderSig(hit.sig),
        kinds: kinds.length ? kinds : [KIND.BODY],
        throwsAdded,
      });
    }
  }

  return { changed, deleted };
}

module.exports = { changedSymbolsIn };
