'use strict';
/**
 * Records what jdtls answers for the Java texts in test/java-symbols/texts.js, as
 * ServerSymbols (UTF-16 offsets), into test/java-symbols/recorded.json, which
 * test/java-symbols.test.js replays. A development script: it needs jdtls (J-D1).
 *
 *   node test/lsp-harness/record-java-symbols.js [--tools java-tools dir]
 *
 * Every text is asked as a base-side document, so it goes through the harness's temporary
 * copy, outside every project (J0: jdtls answers such a file with the same symbols as the
 * project's own). jdtls' `-data` is kept under java-tools/jdtls-data/record (J0: the first
 * file outside a project costs up to ~20 s once per `-data`).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createJdtlsServices, DEFAULT_TOOLS } = require('./jdtls-services');
const texts = require('../java-symbols/texts');

const OUT = path.join(__dirname, '..', 'java-symbols', 'recorded.json');

/** @param {any} s Drops the harness-only `kindName`, leaving the ServerSymbol shape. */
const plainSymbol = (s) => ({
  name: s.name, detail: s.detail, kind: s.kind, range: s.range, selectionRange: s.selectionRange,
  children: (s.children || []).map(plainSymbol),
});

async function main() {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--tools');
  const tools = ti >= 0 ? args[ti + 1] : DEFAULT_TOOLS;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'it-record-java-'));
  const jdtls = createJdtlsServices({
    repo: work, tools, dataDir: path.join(tools, 'jdtls-data', 'record'), scratchDir: path.join(work, 'scratch'),
  });
  try {
    await jdtls.start();
    /** @type {Record<string, { sha256: string, symbols: any[] }>} */
    const out = {};
    for (const [name, text] of Object.entries(texts)) {
      const file = path.join(work, name.split('@')[0]);
      const symbols = await jdtls.documentSymbols({ file, side: 'base', text });
      if (symbols === null) throw new Error(`jdtls gave no symbols for ${name}`);
      out[name] = { sha256: createHash('sha256').update(text).digest('hex'), symbols: symbols.map(plainSymbol) };
    }
    const jar = fs.readdirSync(path.join(tools, 'jdtls', 'plugins')).find((f) => f.startsWith('org.eclipse.jdt.ls.core_'));
    const version = `jdtls ${jar ? jar.replace(/^org\.eclipse\.jdt\.ls\.core_|\.jar$/g, '') : 'unknown'}`;
    // One top-level symbol per line: readable diffs without the size of a fully indented file.
    const body = Object.entries(out).map(([name, r]) => `  ${JSON.stringify(name)}: {"sha256": ${JSON.stringify(r.sha256)}, "symbols": [\n${r.symbols.map((s) => `   ${JSON.stringify(s)}`).join(',\n')}\n  ]}`).join(',\n');
    fs.writeFileSync(OUT, `{"recordedWith": ${JSON.stringify(version)}, "texts": {\n${body}\n}}\n`);
    console.log(`recorded ${Object.keys(out).length} texts into ${OUT} (${version})`);
  } finally {
    await jdtls.close().catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
