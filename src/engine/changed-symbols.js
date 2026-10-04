'use strict';
// The per-file half of the analysis: given the two versions of a file and which lines
// the diff touched, work out which callables changed and how badly.
//
// Split out of analyze.js so the local path (git + disk) and the Tier A path (text
// fetched from the GitHub API) share one implementation. Everything here is pure --
// it never reads a file or shells out — so the caller decides where text comes from.
const { diffSignature, newThrows, KIND } = require('./signature');

const TRIVIA_LINE = /^\s*(\/\/|\/\*|\*|$)/;

// The part of a diff no row represents: changed lines that no changed callable's span
// contains (imports, top-level constants, types, class fields, a doc comment above a
// function). `spans` are the changed callables' [startLine, endLine]; the result has the
// shape of `hunkRanges`, and is empty when every changed line is inside one.
//
// A pure-deletion marker `N - 0.5` is inside a callable only when that callable spans both
// neighbouring lines. One outside every callable is still accounted for when what it
// removed was a deleted callable: the deleted row stands for those base lines, and for the
// blank and comment lines around them (its doc comment goes with it, as the reviewer
// sees it). `hunkDeletions` says which base lines each marker removed; a hunk that removed
// anything else too (an import beside the function), or no callable at all (a lone comment),
// is not explained by a deleted row and is reported. A marker with no entry in
// `hunkDeletions` is reported: when unsure, show it.
function outsideRanges({ spans, hunkRanges, hunkDeletions, deleted, baseText }) {
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  const baseLines = baseText == null ? null : baseText.split('\n');
  const inDeleted = (line) => deleted.some((d) => d.startLine <= line && line <= d.endLine);
  const explainedByDeleted = (at) => {
    const del = hunkDeletions.find((x) => x.at === at);
    if (!del || !baseLines) return false;
    let touchesCallable = false;
    for (let line = del.oldStart; line <= del.oldEnd; line++) {
      if (inDeleted(line)) touchesCallable = true;
      else if (!TRIVIA_LINE.test(baseLines[line - 1] ?? '')) return false;
    }
    return touchesCallable;
  };

  const lines = [];
  const markers = [];
  for (const [lo, hi] of hunkRanges) {
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      const inside = sorted.some(([s, e]) => s < lo && e > hi);
      if (!inside && !explainedByDeleted(lo)) markers.push([lo, hi]);
      continue;
    }
    let from = lo;
    for (const [s, e] of sorted) {
      if (e < from) continue;
      if (s > hi) break;
      if (s > from) lines.push([from, s - 1]);
      from = Math.max(from, e + 1);
    }
    if (from <= hi) lines.push([from, hi]);
  }
  const merged = [];
  for (const r of lines) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], r[1]);
    else merged.push(r.slice());
  }
  return merged.concat(markers).sort((a, b) => a[0] - b[0]);
}

// file: { absPath, relPath, oldPath, status, headText, baseText, hunkRanges, hunkDeletions, component, projectRoot }
// hunkRanges: [[startLine, endLine], ...] 1-based, on the NEW side.
// hunkDeletions: [{ at, oldStart, oldEnd }, ...], what each deletion marker removed from the base.
// Returns { changed, deleted, outside }; `outside` is `outsideRanges`' answer for a file with at
// least one changed or deleted symbol, and [] otherwise: a file with none is listed whole.
function changedSymbolsIn(ts, S, file) {
  const {
    absPath, relPath, oldPath, status, headText, baseText, hunkRanges = [], hunkDeletions = [], component, projectRoot,
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
  // Matched on `key`, not `label`: a label repeats for a get/set pair, overloads, or
  // same-named helpers in two methods, and matching on it diffed against the wrong one.
  const baseByKey = new Map(baseCallables.map((c) => [c.key, c]));
  const headKeys = new Set(headCallables.map((c) => c.key));

  const deleted = [];
  for (const b of baseCallables) {
    if (!headKeys.has(b.key)) {
      deleted.push({ ...b, file: absPath, relPath, oldPath, component, projectRoot });
    }
  }

  const changed = [];
  if (headSf) {
    const picked = new Set();
    const hits = [];
    for (const [lo, hi] of hunkRanges) {
      for (const hit of S.mapRange(headCallables, lo, hi)) {
        if (picked.has(hit.key)) continue;
        picked.add(hit.key);
        hits.push(hit);
      }
    }
    for (const hit of hits) {
      const b = baseByKey.get(hit.key);
      const kinds = diffSignature(b, hit);
      const throwsAdded = newThrows(b, hit);
      if (throwsAdded.length) kinds.push(KIND.NEW_THROW);
      changed.push({
        ...hit,
        file: absPath, relPath, oldPath, component, projectRoot, fileStatus: status,
        added: !b,
        baseSig: b ? S.renderSig(b.sig) : null,
        headSig: S.renderSig(hit.sig),
        kinds: kinds.length ? kinds : [KIND.BODY],
        throwsAdded,
      });
    }
  }

  const outside = headSf && (changed.length || deleted.length)
    ? outsideRanges({ spans: changed.map((c) => [c.startLine, c.endLine]), hunkRanges, hunkDeletions, deleted, baseText })
    : [];
  return { changed, deleted, outside };
}

function changedSymbolKeys(symbols) {
  return new Set(symbols.flatMap((c) => [
    `${c.file}#${c.namePos}`,
    ...(c.isConstructor && c.classNamePos != null ? [`${c.file}#${c.classNamePos}`] : []),
  ]));
}
module.exports = { changedSymbolsIn, changedSymbolKeys };
