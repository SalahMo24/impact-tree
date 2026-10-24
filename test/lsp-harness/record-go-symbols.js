'use strict';
/**
 * Records what gopls answers for the Go texts in test/go-symbols/texts.js, as
 * ServerSymbols (UTF-16 offsets), into test/go-symbols/recorded.json, which
 * test/server-symbols.test.js replays. A development script: it needs gopls.
 *
 *   node test/lsp-harness/record-go-symbols.js [--gopls path]
 *
 * Every text is asked as a base-side document, so it goes through the harness's temporary
 * copy (gate L1 (b)); gopls' symbols are syntactic, so a file outside any module is
 * answered as one inside would be (G0).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createGoplsServices } = require('./gopls-services');
const texts = require('../go-symbols/texts');

const OUT = path.join(__dirname, '..', 'go-symbols', 'recorded.json');

/** @param {any} s Drops the harness-only `kindName`, leaving the ServerSymbol shape. */
const plainSymbol = (s) => ({
  name: s.name, detail: s.detail, kind: s.kind, range: s.range, selectionRange: s.selectionRange,
  children: s.children.map(plainSymbol),
});

async function main() {
  const args = process.argv.slice(2);
  const gi = args.indexOf('--gopls');
  const goplsPath = gi >= 0 ? args[gi + 1] : path.join(os.homedir(), 'go', 'bin', 'gopls');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'it-record-go-'));
  const gopls = createGoplsServices({ repo: work, goplsPath, scratchDir: path.join(work, 'scratch'), deadlineMs: 60000 });
  try {
    await gopls.start({ deadlineMs: 60000 });
    /** @type {Record<string, { sha256: string, symbols: any[] }>} */
    const out = {};
    for (const [name, text] of Object.entries(texts)) {
      const file = path.join(work, name.split('@')[0]);
      const symbols = await gopls.documentSymbols({ file, side: 'base', text });
      if (symbols === null) throw new Error(`gopls gave no symbols for ${name}`);
      out[name] = { sha256: createHash('sha256').update(text).digest('hex'), symbols: symbols.map(plainSymbol) };
    }
    const version = await new Promise((resolve) => {
      require('node:child_process').execFile(goplsPath, ['version'], (e, stdout) => resolve(e ? 'unknown' : stdout.trim().split('\n')[0]));
    });
    fs.writeFileSync(OUT, `${JSON.stringify({ recordedWith: version, texts: out }, null, 1)}\n`);
    console.log(`recorded ${Object.keys(out).length} texts into ${OUT} (${version})`);
  } finally {
    await gopls.close().catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
