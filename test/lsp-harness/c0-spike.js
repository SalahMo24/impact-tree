'use strict';

/**
 * C0b spike: what Roslyn's MIT `roslyn-language-server` gives us, through the harness's LSP
 * client (./roslyn-services.js), on a fixture solution with every call shape and on jellyfin.
 *
 *   node test/lsp-harness/c0-spike.js [--fixture DIR] [--jellyfin DIR] [--only fixture|jellyfin]
 *     [--tools DIR] [--json FILE]
 *
 * Defaults: the scratchpad's csharp-tools/c0b-fixture (Fixture.sln: Lib + App with top-level
 * statements) and ~/Projects/impact-tree-test-repos/jellyfin-c0b (Jellyfin.slnx at 821b849e6,
 * restored beforehand; never the `jellyfin` clone itself: loading writes obj/). For each
 * corpus: launch, open the solution, a query before the load finishes, wait for
 * projectInitializationComplete, documentSymbol on a few files (jellyfin's checked against
 * the C0a-1 syntax oracle cache), call hierarchy + references + implementation at every
 * target, then (jellyfin) incoming calls at 1, 2 and 4 in parallel. One server at a time,
 * shut down after its corpus. Report on stdout, progress on stderr; `--json` also writes
 * every answer. Run it under with-repo-lock.sh (a heavy process on a shared machine).
 */

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createRoslynServices } = require('./roslyn-services');
const { scratchpadPath } = require('./scratchpad');

const OVERALL_DEADLINE_MS = 8 * 60 * 1000;
const PARALLEL_LEVELS = [1, 2, 4];
/** Incoming-calls queries per parallel level (the jellyfin targets, repeated). */
const PARALLEL_QUERIES = 8;

const startedAt = Date.now();
/** @param {string} line */
function say(line = '') { process.stdout.write(`${line}\n`); }
/** @param {string} line */
function progress(line) { process.stderr.write(`[c0 ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${line}\n`); }
/** @param {number} ms */
function fmt(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`; }
/** @param {() => Promise<any>} fn */
async function timed(fn) {
  const t0 = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
  } catch (error) {
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, error: /** @type {Error} */ (error) };
  }
}
/** @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : NaN;
}

/**
 * A target: `snippet` occurs once in `file`; the position is `word`'s first occurrence in it.
 * @typedef {{ label: string, file: string, snippet: string, word: string }} Target
 */

/** @type {Target[]} */
const FIXTURE_TARGETS = [
  { label: 'IFoo.M (interface member)', file: 'Lib/Shapes.cs', snippet: 'int M(int x);', word: 'M' },
  { label: 'Impl.M (implements IFoo.M)', file: 'Lib/Shapes.cs', snippet: 'public int M(int x) => x + 1', word: 'M' },
  { label: 'Base() ctor (: this(), new Derived via : base)', file: 'Lib/Shapes.cs', snippet: 'public Base() { }', word: 'Base' },
  { label: 'Base(int) ctor (: base(1))', file: 'Lib/Shapes.cs', snippet: 'public Base(int n)', word: 'Base' },
  { label: 'Derived() ctor (new Derived())', file: 'Lib/Shapes.cs', snippet: 'public Derived()', word: 'Derived' },
  { label: 'Base.V virtual', file: 'Lib/Shapes.cs', snippet: 'public virtual string V()', word: 'V' },
  { label: 'Derived.V override', file: 'Lib/Shapes.cs', snippet: 'public override string V()', word: 'V' },
  { label: 'Point() ctor (new Point(), Point b = new(), : this())', file: 'Lib/Shapes.cs', snippet: 'public Point() { }', word: 'Point' },
  { label: 'Point(int) ctor (Point c = new(3))', file: 'Lib/Shapes.cs', snippet: 'public Point(int x)', word: 'Point' },
  { label: 'Point.Doubled property (name)', file: 'Lib/Shapes.cs', snippet: 'public int Doubled', word: 'Doubled' },
  { label: 'Point.Doubled get', file: 'Lib/Shapes.cs', snippet: 'get { return X * 2; }', word: 'get' },
  { label: 'Point.Doubled set', file: 'Lib/Shapes.cs', snippet: 'set { X = value / 2; }', word: 'set' },
  { label: 'Ext.Twice (extension; 3.Twice() and Ext.Twice(2))', file: 'Lib/Shapes.cs', snippet: 'Twice(this int x)', word: 'Twice' },
  { label: 'Svc primary ctor (at the type name)', file: 'Lib/Shapes.cs', snippet: 'public class Svc(IFoo foo)', word: 'Svc' },
  { label: 'Svc primary ctor (at the parameter list)', file: 'Lib/Shapes.cs', snippet: 'Svc(IFoo foo)', word: '(' },
  { label: 'Handlers.Handler (method group Map("/x", Handler))', file: 'Lib/Shapes.cs', snippet: 'int Handler()', word: 'Handler' },
  { label: 'Handlers.OnChanged (method group += OnChanged)', file: 'Lib/Shapes.cs', snippet: 'void OnChanged(', word: 'OnChanged' },
  { label: 'Callers.ViaInterface (called from top-level statements)', file: 'Lib/Callers.cs', snippet: 'int ViaInterface(', word: 'ViaInterface' },
  { label: 'a doc comment (no symbol: what an empty answer looks like)', file: 'Lib/Shapes.cs', snippet: '/// <summary>A primary constructor.', word: 'summary' },
  { label: 'Local() (local function in top-level statements)', file: 'App/Program.cs', snippet: 'void Local()', word: 'Local' },
];

/** @type {Target[]} */
const JELLYFIN_TARGETS = [
  { label: 'ILibraryManager.GetItemById(Guid)', file: 'MediaBrowser.Controller/Library/ILibraryManager.cs', snippet: 'BaseItem? GetItemById(Guid id);', word: 'GetItemById' },
  { label: 'LibraryManager.GetItemById(Guid) (implementation, DI singleton)', file: 'Emby.Server.Implementations/Library/LibraryManager.cs', snippet: 'public BaseItem? GetItemById(Guid id)', word: 'GetItemById' },
  { label: 'IUserManager.GetUserById(Guid)', file: 'MediaBrowser.Controller/Library/IUserManager.cs', snippet: 'User? GetUserById(Guid id);', word: 'GetUserById' },
  { label: 'UserManager.GetUserById(Guid) (DI singleton)', file: 'Jellyfin.Server.Implementations/Users/UserManager.cs', snippet: 'public User? GetUserById(Guid id)', word: 'GetUserById' },
  { label: 'ItemsController.GetItems (controller action)', file: 'Jellyfin.Api/Controllers/ItemsController.cs', snippet: 'QueryResult<BaseItemDto>>> GetItems(', word: 'GetItems' },
  { label: 'ClaimsPrincipalExtensions.GetUserId (extension)', file: 'Jellyfin.Api/Extensions/ClaimsPrincipalExtensions.cs', snippet: 'public static Guid GetUserId(this', word: 'GetUserId' },
  { label: 'InternalItemsQuery(User?) ctor', file: 'MediaBrowser.Controller/Entities/InternalItemsQuery.cs', snippet: 'public InternalItemsQuery(User? user)', word: 'InternalItemsQuery' },
  { label: 'Folder.GetChildren(User, bool, InternalItemsQuery) virtual', file: 'MediaBrowser.Controller/Entities/Folder.cs', snippet: 'public virtual IReadOnlyList<BaseItem> GetChildren(User user, bool includeLinkedChildren, InternalItemsQuery query = null)', word: 'GetChildren' },
  { label: 'UserView.GetChildren override', file: 'MediaBrowser.Controller/Entities/UserView.cs', snippet: 'public override List<BaseItem> GetChildren(', word: 'GetChildren' },
  { label: 'Program.StartApp (method group MapResult(StartApp, …))', file: 'Jellyfin.Server/Program.cs', snippet: 'private static async Task StartApp(', word: 'StartApp' },
  { label: 'ILibraryManager.RootFolder (interface property)', file: 'MediaBrowser.Controller/Library/ILibraryManager.cs', snippet: 'AggregateFolder RootFolder { get; }', word: 'RootFolder' },
];

const FIXTURE_SYMBOL_FILES = ['Lib/Shapes.cs', 'App/Program.cs'];
const JELLYFIN_SYMBOL_FILES = [
  'Jellyfin.Api/Controllers/ItemsController.cs',
  'Jellyfin.Server.Implementations/Users/UserManager.cs',
  'MediaBrowser.Controller/Entities/InternalItemsQuery.cs',
  'Emby.Server.Implementations/Library/LibraryManager.cs',
];

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = {
    fixture: scratchpadPath('csharp-tools', 'c0b-fixture'),
    jellyfin: path.join(process.env.HOME || '', 'Projects', 'impact-tree-test-repos', 'jellyfin-c0b'),
    only: /** @type {string|null} */ (null),
    tools: /** @type {string|undefined} */ (undefined),
    json: /** @type {string|null} */ (null),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--fixture') o.fixture = path.resolve(v());
    else if (a === '--jellyfin') o.jellyfin = path.resolve(v());
    else if (a === '--only') o.only = v();
    else if (a === '--tools') o.tools = path.resolve(v());
    else if (a === '--json') o.json = path.resolve(v());
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** @param {string} repo @param {Target} t */
function locate(repo, t) {
  const file = path.join(repo, t.file);
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf(t.snippet);
  if (at < 0 || text.indexOf(t.snippet, at + 1) >= 0) throw new Error(`${t.file}: snippet ${JSON.stringify(t.snippet)} not found once`);
  const w = t.snippet.indexOf(t.word);
  if (w < 0) throw new Error(`${t.label}: word not in snippet`);
  return { file, text, pos: at + w };
}

/** 1-based line of an offset. @param {string} text @param {number} offset */
function lineOf(text, offset) { let n = 1; for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++; return n; }

/** "File.cs:12" for a uri and offset. @param {any} services @param {string} uri @param {number} offset @param {string} repo */
function where(services, uri, offset, repo) {
  const file = fileURLToPath(uri);
  return `${path.relative(repo, file)}:${lineOf(services.textOfUri(uri), offset)}`;
}

/** The call-site text of a range, one line. @param {any} services @param {string} uri @param {{ start: number, end: number }} r */
function siteText(services, uri, r) {
  const text = services.textOfUri(uri);
  const ls = text.lastIndexOf('\n', r.start - 1) + 1;
  const le = text.indexOf('\n', r.end);
  return text.slice(ls, le < 0 ? text.length : le).trim().slice(0, 90);
}

/**
 * Cross-checks documentSymbol against the C0a-1 syntax oracle: each oracle member is paired
 * with the server symbol whose selectionRange starts at its nameOffset.
 * @param {any[]} symbols @param {any} oracleFile @param {string} text
 */
function compareWithOracle(symbols, oracleFile, text) {
  /** @type {any[]} */
  const flat = [];
  const walk = (/** @type {any[]} */ list, /** @type {string} */ parent) => { for (const s of list) { flat.push({ ...s, parent }); walk(s.children, s.name); } };
  walk(symbols, '');
  const bySel = new Map(flat.map((s) => [s.selectionRange.start, s]));
  const out = { oracle: oracleFile.members.length, paired: 0, rangeEqual: 0, startAtAttribute: 0, includesDoc: 0, /** @type {string[]} */ diffs: [] };
  for (const m of oracleFile.members) {
    const s = bySel.get(m.nameOffset);
    if (!s) { if (out.diffs.length < 6) out.diffs.push(`unpaired ${m.kind} ${m.key} (line ${m.startLine})`); continue; }
    out.paired++;
    if (s.range.start === m.start && s.range.end === m.end) out.rangeEqual++;
    else if (out.diffs.length < 6) out.diffs.push(`${m.key}: server ${lineOf(text, s.range.start)}-${lineOf(text, s.range.end)} [${s.range.start},${s.range.end}) oracle ${m.startLine}-${m.endLine} [${m.start},${m.end}) name "${s.name}" detail "${s.detail}"`);
    if (m.attributes.length && s.range.start === m.start) out.startAtAttribute++;
    if (s.range.start < m.start && /\/\/\//.test(text.slice(s.range.start, m.start))) out.includesDoc++;
  }
  return out;
}

/**
 * @param {{ name: string, repo: string, solution: string, targets: Target[], symbolFiles: string[],
 *   oracle?: any, parallel: boolean, tools?: string }} corpus
 */
async function runCorpus(corpus) {
  /** @type {any} */
  const result = { corpus: corpus.name, targets: [], symbols: [], parallel: [] };
  say(`## ${corpus.name} (${corpus.solution})`);
  const services = createRoslynServices({ repo: corpus.repo, solution: corpus.solution, ...(corpus.tools ? { tools: corpus.tools } : {}), deadlineMs: 180000 });
  const first = locate(corpus.repo, corpus.targets[0]);
  try {
    progress(`${corpus.name}: starting`);
    /** @type {Promise<any>|null} */
    let early = null;
    const launch = Date.now();
    const started = await services.start({
      onOpened: () => {
        // One query while the solution loads: what "still loading" looks like.
        early = timed(async () => {
          const items = await services.prepareCallHierarchy({ file: first.file, text: first.text }, first.pos);
          const calls = items && items[0] ? await services.incomingCalls(items[0]) : null;
          return { items: items ? items.length : null, calls: calls ? calls.length : null, atMs: Date.now() - launch };
        });
      },
    });
    const earlyResult = early ? await early : null;
    say(`- initialize answered in ${fmt(started.initializedMs)}; projectInitializationComplete ${fmt(started.loadedMs)} after launch`);
    const caps = started.capabilities.capabilities || {};
    say(`- capabilities: callHierarchy ${JSON.stringify(caps.callHierarchyProvider)}, references ${JSON.stringify(caps.referencesProvider)}, implementation ${JSON.stringify(caps.implementationProvider)}, documentSymbol ${JSON.stringify(caps.documentSymbolProvider)}; server ${JSON.stringify(started.capabilities.serverInfo || null)}`);
    if (earlyResult) say(`- query sent right after solution/open (${corpus.targets[0].label}): ${earlyResult.error ? `error ${earlyResult.error.message}` : `${earlyResult.value.items} item(s), ${earlyResult.value.calls} incoming, answered ${fmt(earlyResult.value.atMs)} after launch`} (load complete at ${fmt(started.loadedMs)})`);
    result.load = { ...started, capabilities: undefined, early: earlyResult && (earlyResult.value || String(earlyResult.error)) };

    // documentSymbol
    for (const rel of corpus.symbolFiles) {
      const file = path.join(corpus.repo, rel);
      const text = fs.readFileSync(file, 'utf8');
      const r = await timed(() => services.documentSymbols({ file, text }));
      if (r.error) { say(`- documentSymbol ${rel}: error ${r.error.message}`); continue; }
      /** @type {string[]} */
      const sample = [];
      const walk = (/** @type {any[]} */ list, /** @type {number} */ depth) => { for (const s of list) { if (sample.length < 40) sample.push(`${'  '.repeat(depth)}${s.kindName} "${s.name}" detail "${s.detail}" lines ${lineOf(text, s.range.start)}-${lineOf(text, s.range.end)} sel ${lineOf(text, s.selectionRange.start)}`); walk(s.children, depth + 1); } };
      walk(r.value || [], 0);
      say(`- documentSymbol ${rel}: ${fmt(r.ms)}, ${(r.value || []).length} top-level`);
      for (const line of sample) say(`    ${line}`);
      const oracleFile = corpus.oracle && corpus.oracle.files.find((/** @type {any} */ f) => f.path === rel);
      if (oracleFile) {
        const c = compareWithOracle(r.value || [], oracleFile, text);
        say(`  vs oracle: ${c.oracle} members, paired by name offset ${c.paired}, range equal ${c.rangeEqual}, server range starts at the attribute ${c.startAtAttribute}, server range includes the doc comment ${c.includesDoc}`);
        for (const d of c.diffs) say(`    ${d}`);
        result.symbols.push({ file: rel, ...c });
      }
    }

    // call hierarchy, references, implementation per target
    /** @type {any[]} */
    const prepared = [];
    for (const t of corpus.targets) {
      const { file, text, pos } = locate(corpus.repo, t);
      const doc = { file, text };
      const prep = await timed(() => services.prepareCallHierarchy(doc, pos));
      /** @type {any} */
      const entry = { label: t.label, prepareMs: prep.ms };
      say(`### ${t.label} (${t.file}:${lineOf(text, pos)})`);
      if (prep.error) { say(`- prepare: error ${prep.error.message}`); entry.prepareError = prep.error.message; result.targets.push(entry); continue; }
      const items = prep.value || [];
      entry.items = items.map((/** @type {any} */ i) => ({ name: i.name, detail: i.detail, kind: i.kind }));
      say(`- prepare ${fmt(prep.ms)}: ${prep.value === null ? 'null' : items.map((/** @type {any} */ i) => `"${i.name}" detail "${i.detail}" kind ${i.kind}`).join('; ') || '[]'}`);
      if (items[0]) {
        prepared.push({ label: t.label, item: items[0] });
        const inc = await timed(() => services.incomingCalls(items[0]));
        if (inc.error) { say(`- incoming: error ${inc.error.message}`); entry.incomingError = inc.error.message; } else {
          const calls = inc.value || [];
          entry.incomingMs = inc.ms;
          entry.incoming = calls.map((/** @type {any} */ c) => ({ name: c.from.name, detail: c.from.detail, kind: c.from.kind, at: where(services, c.from.uri, c.from.selectionRange.start, corpus.repo), sites: c.fromRanges.map((/** @type {any} */ r) => `${where(services, c.from.uri, r.start, corpus.repo)} ${siteText(services, c.from.uri, r)}`) }));
          say(`- incoming ${fmt(inc.ms)}: ${calls.length} caller(s), ${calls.reduce((n, c) => n + c.fromRanges.length, 0)} site(s)`);
          for (const c of calls.filter((/** @type {any} */ c) => /top-level/.test(c.from.name)).slice(0, 1)) say(`    top-level caller raw: range ${JSON.stringify(c.from.raw.range)} selectionRange ${JSON.stringify(c.from.raw.selectionRange)}`);
          for (const c of entry.incoming.slice(0, 12)) say(`    "${c.name}" detail "${c.detail}" kind ${c.kind} at ${c.at}; sites: ${c.sites.join(' | ')}`);
          if (entry.incoming.length > 12) say(`    … ${entry.incoming.length - 12} more`);
        }
      }
      const refs = await timed(() => services.references(doc, pos));
      entry.referencesMs = refs.ms;
      entry.references = refs.error ? `error ${refs.error.message}` : (refs.value || []).map((/** @type {any} */ l) => `${where(services, l.uri, l.start, corpus.repo)} ${siteText(services, l.uri, l)}`);
      say(`- references ${fmt(refs.ms)}: ${Array.isArray(entry.references) ? `${entry.references.length}${entry.references.length ? `: ${entry.references.slice(0, 6).join(' | ')}` : ''}` : entry.references}`);
      const impl = await timed(() => services.implementations(doc, pos));
      entry.implementationMs = impl.ms;
      entry.implementation = impl.error ? `error ${impl.error.message}` : (impl.value || []).map((/** @type {any} */ l) => where(services, l.uri, l.start, corpus.repo));
      say(`- implementation ${fmt(impl.ms)}: ${Array.isArray(entry.implementation) ? `${entry.implementation.length}${entry.implementation.length ? `: ${entry.implementation.slice(0, 6).join(', ')}` : ''}` : entry.implementation}`);
      result.targets.push(entry);
    }

    if (corpus.parallel && prepared.length) {
      say('### incoming calls in parallel');
      for (const level of PARALLEL_LEVELS) {
        const queue = Array.from({ length: PARALLEL_QUERIES }, (_, i) => prepared[i % prepared.length]);
        /** @type {number[]} */
        const times = [];
        /** @type {string[]} */
        const errors = [];
        const t0 = Date.now();
        let next = 0;
        await Promise.all(Array.from({ length: level }, async () => {
          while (next < queue.length) {
            const q = queue[next++];
            const r = await timed(() => services.incomingCalls(q.item));
            times.push(r.ms);
            if (r.error) errors.push(`${q.label}: ${r.error.message}`);
          }
        }));
        const wall = Date.now() - t0;
        say(`- ${level} at a time: ${queue.length} queries in ${fmt(wall)}, median ${fmt(median(times))}, max ${fmt(Math.max(...times))}, errors ${errors.length}${errors.length ? `: ${errors.slice(0, 3).join('; ')}` : ''}`);
        result.parallel.push({ level, queries: queue.length, wallMs: wall, medianMs: median(times), maxMs: Math.max(...times), errors });
      }
    }

    // what the server sent besides answers
    const counts = new Map();
    for (const e of services.events) counts.set(`${e.kind} ${e.method}`, (counts.get(`${e.kind} ${e.method}`) || 0) + 1);
    say(`- server messages: ${[...counts].map(([k, n]) => `${k} ×${n}`).join(', ')}`);
    const restore = services.serverRequests.filter((r) => /restore/i.test(r.method));
    say(`- restore requests from the server: ${restore.length}${restore.length ? ` (${restore.map((r) => `${r.method} ${JSON.stringify(r.params).slice(0, 160)}`).join('; ')})` : ''}`);
    const progressTitles = services.events.filter((e) => e.method === '$/progress' && e.detail.startsWith('begin')).map((e) => `${e.detail.slice(6)} @${fmt(e.ms)}`);
    say(`- progress begun: ${progressTitles.slice(0, 8).join(', ') || 'none'}`);
    say(`- warnings/errors logged by the server: ${services.problems.length}${services.problems.length ? `, first: ${services.problems.slice(0, 3).join(' || ')}` : ''}`);
    result.events = services.events;
    result.problems = services.problems;
  } finally {
    const t = Date.now();
    await services.close();
    progress(`${corpus.name}: server closed in ${Date.now() - t} ms`);
  }
  say('');
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deadline = setTimeout(() => { progress(`past the ${OVERALL_DEADLINE_MS / 60000} min deadline; exiting`); process.exit(2); }, OVERALL_DEADLINE_MS);
  deadline.unref();
  /** @type {any[]} */
  const results = [];
  say(`# C0b spike (${new Date().toISOString()})`);
  if (opts.only !== 'jellyfin') {
    results.push(await runCorpus({ name: 'fixture', repo: opts.fixture, solution: 'Fixture.sln', targets: FIXTURE_TARGETS, symbolFiles: FIXTURE_SYMBOL_FILES, parallel: false, tools: opts.tools }));
  }
  if (opts.only !== 'fixture') {
    const cacheDir = scratchpadPath('csharp-tools', 'cache');
    const cache = fs.readdirSync(cacheDir).find((f) => f.startsWith('syntax-jellyfin-821b849e61f6-'));
    const oracle = cache ? JSON.parse(fs.readFileSync(path.join(cacheDir, cache), 'utf8')) : undefined;
    results.push(await runCorpus({ name: 'jellyfin', repo: opts.jellyfin, solution: 'Jellyfin.slnx', targets: JELLYFIN_TARGETS, symbolFiles: JELLYFIN_SYMBOL_FILES, oracle, parallel: true, tools: opts.tools }));
  }
  say(`total ${fmt(Date.now() - startedAt)}`);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(results, null, 2));
}

main().catch((err) => { process.stderr.write(`${err && err.stack ? err.stack : err}\n`); process.exit(1); });
