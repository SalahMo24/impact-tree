'use strict';
// GitHub hands us the unified diff it already computed, so Tier A does not need to
// re-derive one. But that patch carries three lines of context either side, and the
// local path deliberately uses `--unified=0`: a context line is NOT a changed line,
// and treating it as one drags neighbouring functions into the result.
//
// So rather than trusting the @@ header's span, walk the hunk body and record only
// the lines actually marked + or -. That reproduces --unified=0 semantics exactly.

// `hunkRangesFromPatch` returns [[startLine, endLine], ...] 1-based on the NEW side, merged
// and sorted.
//
// A pure deletion (a run of `-` lines not followed by `+` lines) has no new-side line
// of its own. It is recorded as the fractional marker `N - 0.5` -- the gap before new
// line N -- exactly as `diff.js` records git's `+N,0` header. Anchoring it on a real
// line made the function after the deletion (or before it) look changed, and could
// mark an untouched neighbouring call site as updated.
function hunkRangesFromPatch(patch) {
  return walkPatch(patch).ranges;
}

// Removed base lines (1-based, inclusive), including replacement runs. `at` is the
// gap before the run; `newEnd` exists only when added lines replace the removed ones.
function hunkDeletionsFromPatch(patch) {
  return walkPatch(patch).deletions;
}

function walkPatch(patch) {
  if (!patch) return { ranges: [], deletions: [] };
  const lines = String(patch).split('\n');
  const touched = [];
  const markers = [];
  const deletions = [];
  let newLine = 0;
  let oldLine = 0;
  let inHunk = false;
  let deletedFrom = null;
  let deletedAt = null;
  const flush = () => {
    if (deletedFrom !== null) {
      const replaced = newLine > deletedAt + 0.5;
      if (!replaced) markers.push([deletedAt, deletedAt]);
      deletions.push({ at: deletedAt, oldStart: deletedFrom, oldEnd: oldLine - 1,
        ...(replaced ? { newEnd: newLine - 1 } : {}) });
    }
    deletedFrom = null;
    deletedAt = null;
  };

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      flush();
      // `+0,0` (the file became empty) still means "before line 1"
      newLine = Math.max(1, parseInt(header[2], 10) + (header[3] === '0' ? 1 : 0));
      oldLine = parseInt(header[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue;           // "\ No newline at end of file"
    const c = line[0];
    if (c === '+') { touched.push([newLine, newLine]); newLine++; }
    else if (c === '-') {
      if (deletedFrom !== null && newLine > deletedAt + 0.5) flush();
      if (deletedFrom === null) { deletedFrom = oldLine; deletedAt = newLine - 0.5; }
      oldLine++;
    }
    else { flush(); newLine++; oldLine++; }          // context line, or an empty one
  }
  flush();

  const merged = [];
  if (touched.length) {
    touched.sort((a, b) => a[0] - b[0]);
    merged.push(touched[0].slice());
    for (let i = 1; i < touched.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = touched[i];
      if (cur[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], cur[1]);
      else merged.push(cur.slice());
    }
  }
  // markers are never merged into a neighbouring range: that would re-anchor them
  return { ranges: merged.concat(markers).sort((a, b) => a[0] - b[0]), deletions };
}

module.exports = { hunkRangesFromPatch, hunkDeletionsFromPatch };
