// @ts-check
'use strict';
// C3's outline in the shape `csharp-verify.js --syntactic --outline` reads: the file's members
// as `{ key, kind, nameOffset, start, end }`, keyed as the provider keys them
// (src/languages/csharp/provider.js `collectCsharpSymbols`). Throws for a file the outline
// cannot read (the provider reports it as not analysed), so the verifier lists it.
const path = require('path');
const { csharpOutline } = require('../../src/languages/csharp/outline');
const { collectCsharpSymbols } = require('../../src/languages/csharp/provider');

/** @param {string} text @param {string} [file] */
function outlineOf(text, file = 'Program.cs') {
  const symbols = csharpOutline(text, { fileName: path.basename(file) });
  if (!symbols) throw new Error('not analysed: the outline cannot read this file');
  return collectCsharpSymbols(symbols, text).map((s) => ({ key: s.key, kind: s.csharpKind, nameOffset: s.namePos, start: s.start, end: s.end }));
}

module.exports = { outlineOf };
