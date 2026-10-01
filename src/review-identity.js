'use strict';
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { makeSymbols } = require('./engine/symbols');
const { virtualText } = require('./engine/textpos');
const hash = (s) => createHash('sha256').update(s == null ? '<absent>' : s).digest('hex');

// A fresh identity index for each completed analysis. Offsets locate a declaration;
// they never form its persisted identity. Both sides participate in invalidation.
function createReviewIdentity(ts, repo, result, baseText) {
  const cache = new Map();
  const S = makeSymbols(ts);
  const read = (file) => {
    const rel = path.relative(repo, file).split(path.sep).join('/');
    if (!cache.has(file)) {
      let head = virtualText(file);
      if (head == null) { try { head = fs.readFileSync(file, 'utf8'); } catch { head = null; } }
      const base = baseText(rel);
      const collect = (text) => text == null ? [] : S.collect(ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true));
      const before = new Map(collect(base).map((s) => [s.key, s]));
      const symbols = collect(head).map((s) => {
        const b = before.get(s.key);
        return { ...s, id: `${rel}#${s.key}:${hash(head.slice(s.start, s.end))}:${hash(b ? base.slice(b.start, b.end) : null)}` };
      });
      cache.set(file, { rel, symbols, id: `${rel}:${hash(head)}:${hash(base)}` });
    }
    return cache.get(file);
  };
  return (n) => {
    const file = n.file || n.absPath || (n.relPath && path.join(repo, n.relPath));
    if (!file) return null;
    const entry = read(file);
    if (n.type === 'file' || n.type === 'deleted') return `${n.type}:${entry.id}`;
    const s = entry.symbols.find((s) => s.namePos === n.pos)
      || entry.symbols.find((s) => s.isConstructor && s.classNamePos === n.pos);
    return s ? s.id : entry.id;
  };
}
module.exports = { createReviewIdentity };
