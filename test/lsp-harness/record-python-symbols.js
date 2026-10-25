'use strict';
/**
 * Records what Pyright answers for the Python texts in test/python-symbols/texts.js, as
 * ServerSymbols (UTF-16 offsets), into test/python-symbols/recorded.json, which
 * test/python-symbols.test.js replays. A development script: it needs Pyright (P-D1).
 *
 *   node test/lsp-harness/record-python-symbols.js [--pyright path]
 *
 * Every text is asked as a base-side document, so it goes through the harness's temporary
 * copy (P0: Pyright answers a file outside the workspace as one inside).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPyrightServices, DEFAULT_PYRIGHT } = require('./pyright-services');
const texts = require('../python-symbols/texts');

const OUT = path.join(__dirname, '..', 'python-symbols', 'recorded.json');

/** @param {any} s Drops the harness-only `kindName`, leaving the ServerSymbol shape. */
const plainSymbol = (s) => ({
  name: s.name, detail: s.detail, kind: s.kind, range: s.range, selectionRange: s.selectionRange,
  children: s.children.map(plainSymbol),
});

async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--pyright');
  const pyrightPath = pi >= 0 ? args[pi + 1] : DEFAULT_PYRIGHT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'it-record-py-'));
  const pyright = createPyrightServices({ repo: work, pyrightPath, scratchDir: path.join(work, 'scratch'), deadlineMs: 60000 });
  try {
    await pyright.start({ deadlineMs: 60000 });
    /** @type {Record<string, { sha256: string, symbols: any[] }>} */
    const out = {};
    for (const [name, text] of Object.entries(texts)) {
      const file = path.join(work, name.split('@')[0]);
      const symbols = await pyright.documentSymbols({ file, side: 'base', text });
      if (symbols === null) throw new Error(`Pyright gave no symbols for ${name}`);
      out[name] = { sha256: createHash('sha256').update(text).digest('hex'), symbols: symbols.map(plainSymbol) };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(pyrightPath)), 'package.json'), 'utf8'));
    const version = `pyright ${pkg.version}`;
    // One symbol per line: readable diffs without the size of a fully indented file.
    const body = Object.entries(out).map(([name, r]) => `  ${JSON.stringify(name)}: {"sha256": ${JSON.stringify(r.sha256)}, "symbols": [\n${r.symbols.map((s) => `   ${JSON.stringify(s)}`).join(',\n')}\n  ]}`).join(',\n');
    fs.writeFileSync(OUT, `{"recordedWith": ${JSON.stringify(version)}, "texts": {\n${body}\n}}\n`);
    console.log(`recorded ${Object.keys(out).length} texts into ${OUT} (${version})`);
  } finally {
    await pyright.close().catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
