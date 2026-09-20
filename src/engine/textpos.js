'use strict';
const fs = require('fs');

// Offset <-> line/character conversion done from disk. Using
// vscode.workspace.openTextDocument for this forces the editor to sync the whole
// document to the extension host, which Cursor refuses for many files ("Documents
// above the size limit cannot be synchronized with extensions") and which is slow
// even when it succeeds. VS Code Positions are UTF-16 code units per line, which is
// exactly what JS string indexing gives us, so the conversion is exact.
const cache = new Map();

function lineStarts(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const entry = { key, starts, length: text.length };
  cache.set(file, entry);
  return entry;
}

function offsetToPosition(file, offset) {
  const e = lineStarts(file);
  if (!e) return null;
  const o = Math.max(0, Math.min(offset, e.length));
  let lo = 0, hi = e.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (e.starts[mid] <= o) lo = mid; else hi = mid - 1; }
  return { line: lo, character: o - e.starts[lo] };
}

function positionToOffset(file, line, character) {
  const e = lineStarts(file);
  if (!e) return null;
  const l = Math.max(0, Math.min(line, e.starts.length - 1));
  return Math.min(e.starts[l] + Math.max(0, character), e.length);
}

module.exports = { offsetToPosition, positionToOffset, _clear: () => cache.clear() };
