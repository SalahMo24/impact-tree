'use strict';
// GitHub hands us the unified diff it already computed, so Tier A does not need to
// re-derive one. But that patch carries three lines of context either side, and the
// local path deliberately uses `--unified=0`: a context line is NOT a changed line,
// and treating it as one drags neighbouring functions into the result.
//
// So rather than trusting the @@ header's span, walk the hunk body and record only
// the lines actually marked + or -. That reproduces --unified=0 semantics exactly.

// Returns [[startLine, endLine], ...] 1-based on the NEW side, merged and sorted.
// A pure deletion has no new-side line of its own, so it is recorded as a zero-width
// marker at the line it was removed from -- otherwise removing a call would map to
// no symbol at all.
function hunkRangesFromPatch(patch) {
  if (!patch) return [];
  const lines = String(patch).split('\n');
  const touched = [];
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      newLine = parseInt(header[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue;            // "\ No newline at end of file"
    const c = line[0];
    if (c === '+') { touched.push([newLine, newLine]); newLine++; }
    else if (c === '-') { touched.push([Math.max(1, newLine), Math.max(1, newLine)]); }
    else { newLine++; }                             // context line, or an empty one
  }

  if (!touched.length) return [];
  touched.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [touched[0].slice()];
  for (let i = 1; i < touched.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = touched[i];
    if (cur[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], cur[1]);
    else merged.push(cur.slice());
  }
  return merged;
}

module.exports = { hunkRangesFromPatch };
