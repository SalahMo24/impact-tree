#!/usr/bin/env node
// @ts-check
'use strict';
/**
 * Entry-point census for C# (Part C, C4; src/engine/entry-points-csharp.js). A development
 * script, not part of `npm test`.
 *
 *   node test/lsp-harness/entry-census.js [--sample-out <file>] [--update-routes] [--jellyfin <clone>] [--eshop <clone>]
 *
 * For jellyfin (821b849e6) and eShop (ab10e4c), at those commits, read with `git cat-file`
 * (nothing is checked out): the members (methods) come from the Roslyn syntax oracle's
 * cached output (csharp-tools/cache/syntax-*.json: name, offset, modifiers, attributes,
 * parameter types, container type path). The oracle has no class-level data, so each class's
 * attributes and base list come from a LINE scanner written here (a class header line, the
 * `[...]` lines above it, the text up to its `{`), which shares nothing with the rules
 * (they match on lexer-blanked offsets). The expected sets follow C-D7's wording:
 *
 *   controller action  oracle method, `public`, not `static`, not generic, no `[NonAction]`, not
 *                      `OnActionExecuting`/`OnActionExecuted`/`OnActionExecutionAsync`/`Dispose`/
 *                      `ToString`/`Equals`/`GetHashCode`, not an `override` in a class based directly
 *                      on `Controller`/`ControllerBase`; in a class that is not `abstract`, not
 *                      generic, not `[NonController]`, with `[ApiController]`/`[Controller]`, or a
 *                      base `Controller`/`ControllerBase`, or (with ASP.NET evidence) a base type
 *                      (not an `I…` interface) ending `Controller`/`ControllerBase`, or named
 *                      `…Controller` with no base list at all. Evidence: the file has a
 *                      `using Microsoft.AspNetCore.Mvc` line, or the class or one of its methods
 *                      (oracle attributes) has `[Http*]`/`[Route]`/`[AcceptVerbs]`/`[ApiController]`,
 *                      or the base chain, read by the same line scanner over the files read, reaches
 *                      `Controller`/`ControllerBase` or a file with that `using`
 *   minimal-API handler oracle method whose name is a whole-word argument of a statement that
 *                      starts at `.MapGet(`/`.MapPost(`/`.MapPut(`/`.MapDelete(`/`.MapPatch(`
 *                      /`.MapMethods(` in the same file (string literals removed)
 *   gRPC method        `override` with a `ServerCallContext` parameter, class base `X.XBase`
 *   hosted service     `ExecuteAsync` of a class based on `BackgroundService`;
 *                      `StartAsync`/`StopAsync` of one based on `IHostedService`
 *   integration handler `Handle` of a class based on `IIntegrationEventHandler<…>`
 *   SignalR hub        public non-static method of a class based on `Hub`/`Hub<T>`, in a file with a
 *                      `using Microsoft.AspNetCore.SignalR;` line or with the base written qualified
 *   MediatR handler    `Handle` of a class based on `IRequestHandler<…>`/`INotificationHandler<…>`
 *   Main               `static Main`
 *
 * It proves coverage of C-D7's rules by an independent reading, not that routes are right:
 * C-D9's sample (30 jellyfin actions, all eShop minimal-API handlers) is printed for a hand
 * check, with file:line, the attributes and the route computed, then eShop's MVC actions
 * (Identity.API, conventionally routed). Also: a deterministic sample
 * of 100 methods that are no expected entry, none of which may be `http`, and every method
 * the rules call an entry without it being expected.
 *
 * The route sample (with each entry's caveat after its name, as the views show it) is compared
 * with the hand-checked copy committed beside this script, entry-census-routes.txt; any
 * difference fails. `--update-routes` rewrites that copy after a change has been checked by hand.
 *
 * Exit code 1 when any expected entry is missing, an extra is found, a negative is `http`, or
 * the route sample differs from entry-census-routes.txt.
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { declarationEntry, callSiteEntry, unreachableReason } = require('../../src/engine/entry-points');
const { classRoutesOf } = require('../../src/engine/entry-points-csharp');
const { blank } = require('../../src/languages/csharp/lexer');

const CACHE = path.join(os.homedir(), 'Projects', 'impact-tree-scratchpad', 'csharp-tools', 'cache');
const REPOS = [
  { name: 'jellyfin', dir: path.join(os.homedir(), 'Projects', 'impact-tree-test-repos', 'jellyfin'), commit: '821b849e61f6', cache: 'syntax-jellyfin-821b849e61f6-78681b53ab0c.json' },
  { name: 'eshop', dir: path.join(os.homedir(), 'Projects', 'impact-tree-test-repos', 'eshop'), commit: 'ab10e4c68fd2', cache: 'syntax-eshop-ab10e4c68fd2-78681b53ab0c.json' },
];
const NEGATIVE_SAMPLE = 100;
const ROUTES_FILE = path.join(__dirname, 'entry-census-routes.txt');
/** An entry as the views show it: its name, then its caveat. @param {any} e */
const shown = (e) => (e ? `${e.name}${e.caveat ? ` (${e.caveat})` : ''}` : '(no entry)');
const ACTION_SAMPLE = 30;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ sampleOut: string|null, updateRoutes: boolean, dirs: Record<string, string> }} */
  const out = { sampleOut: null, updateRoutes: false, dirs: {} };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--update-routes') { out.updateRoutes = true; i--; }
    else if (argv[i] === '--sample-out') out.sampleOut = argv[i + 1];
    else if (argv[i] === '--jellyfin') out.dirs.jellyfin = argv[i + 1];
    else if (argv[i] === '--eshop') out.dirs.eshop = argv[i + 1];
    else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
  }
  return out;
}

/** Blob texts of `paths` at `commit` in one `git cat-file --batch`. @param {string} dir @param {string} commit @param {string[]} paths */
function readBlobs(dir, commit, paths) {
  const res = spawnSync('git', ['-C', dir, 'cat-file', '--batch'], { input: paths.map((p) => `${commit}:${p}\n`).join(''), maxBuffer: 1 << 30 });
  if (res.status !== 0) throw new Error(`git cat-file failed in ${dir}: ${String(res.stderr)}`);
  const buf = res.stdout;
  /** @type {Map<string, string>} */
  const out = new Map();
  let at = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, at);
    const header = buf.toString('utf8', at, nl);
    const m = /^\S+ blob (\d+)$/.exec(header);
    if (!m) { at = nl + 1; continue; }
    const size = Number(m[1]);
    // A BOM stays: the oracle's offsets count it, as Node's readFileSync does.
    out.set(p, buf.toString('utf8', nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return out;
}

/**
 * @typedef {{ attrs: string, bases: string[], abstract: boolean, generic: boolean, mvcFile: boolean }} LineClass
 */
/**
 * Classes of a file by line scanning: name -> { attrs (text of the lines above), bases (names),
 * abstract, generic, mvcFile (the file has a `using Microsoft.AspNetCore.Mvc` line) }.
 * @param {string} text @returns {Map<string, LineClass>}
 */
function classesByLines(text) {
  const lines = text.split('\n');
  const mvcFile = lines.some((l) => /^\s*(?:global\s+)?using\s+Microsoft\.AspNetCore\.Mvc(?:\.|;|\s)/.test(l));
  /** @type {Map<string, LineClass>} */
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*((?:(?:public|internal|private|protected|sealed|abstract|static|partial|unsafe|file|readonly)\s+)*)(?:record\s+(?:class|struct)|class|record|struct)\s+([A-Za-z_]\w*)(\s*<)?/.exec(lines[i]);
    if (!m || /^\s*\/\//.test(lines[i])) continue;
    // header: up to the line with `{` (or `;`)
    let header = '';
    for (let k = i; k < Math.min(lines.length, i + 12); k++) {
      header += ` ${lines[k]}`;
      if (/[{;]/.test(lines[k])) break;
    }
    header = header.slice(header.indexOf(m[2]) + m[2].length).replace(/\{.*$/, '');
    // parameters of a primary constructor are not bases: drop a leading (...) group
    let rest = header.trim();
    rest = rest.replace(/^<[^(:{]*?>(?=\s|\(|:|$)/, '').trim();
    if (rest.startsWith('(')) { let d = 0; let j = 0; for (; j < rest.length; j++) { if (rest[j] === '(') d++; else if (rest[j] === ')' && --d === 0) { j++; break; } } rest = rest.slice(j).trim(); }
    const colon = rest.startsWith(':') ? rest.slice(1) : '';
    const baseText = colon.replace(/\swhere\s[^]*$/, '');
    const bases = [];
    let depth = 0; let cur = '';
    for (const ch of baseText) {
      if (ch === '<' || ch === '(') depth++; else if (ch === '>' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { bases.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) bases.push(cur.trim());
    // attributes: the `[` lines directly above (comments and blank lines skipped), multi-line lists joined
    let attrs = '';
    for (let k = i - 1; k >= 0 && k > i - 20; k--) {
      const l = lines[k].trim();
      if (!l || l.startsWith('//')) continue;
      if (l.startsWith('[') || /^[\w."(),:\s]+\)?\]?,?$/.test(l) && attrs.length && !/[;{}]$/.test(l)) { attrs = `${l} ${attrs}`; continue; }
      break;
    }
    out.set(m[2], { attrs, bases, abstract: /\babstract\b/.test(m[1]), generic: !!m[3], mvcFile });
  }
  return out;
}

/** @param {string} b the type text without namespace and arguments: `A.B<C>` -> `B` */
const baseId = (b) => b.replace(/<.*$/s, '').replace(/^.*\./, '').trim();

/** Names that are whole-word arguments of `.MapX(` statements of a file. @param {string} text @returns {Set<string>} */
function mapHandlerNames(text) {
  const names = new Set();
  const noStrings = text.replace(/\$?@?"(?:[^"\\\n]|\\.)*"/g, '""');
  const re = /\.(?:MapGet|MapPost|MapPut|MapDelete|MapPatch|MapMethods)\(/g;
  let m;
  while ((m = re.exec(noStrings))) {
    // the statement: up to the next `;` at brace depth 0 relative to here
    let d = 0; let end = m.index;
    for (; end < noStrings.length; end++) {
      const c = noStrings[end];
      if (c === '{' || c === '(' || c === '[') d++;
      else if (c === '}' || c === ')' || c === ']') d--;
      else if (c === ';' && d <= 0) break;
      if (d < 0) break;
    }
    // only the first call's own argument list, not what is chained after it
    let depth = 0; let k = m.index + m[0].length - 1;
    for (; k < end; k++) { if (noStrings[k] === '(') depth++; else if (noStrings[k] === ')' && --depth === 0) break; }
    const args = noStrings.slice(m.index + m[0].length, k);
    // top-level arguments only: skip lambdas' insides
    let dd = 0; let cur = ''; const parts = [];
    for (const ch of args) {
      if ('([{'.includes(ch)) dd++; else if (')]}'.includes(ch)) dd--;
      if (ch === ',' && dd === 0) { parts.push(cur); cur = ''; } else if (dd === 0 || '([{'.includes(ch)) cur += ch;
    }
    parts.push(cur);
    for (const p of parts) { const id = /^\s*(?:[A-Za-z_]\w*\s*\.\s*)*([A-Za-z_]\w*)\s*$/.exec(p); if (id) names.add(id[1]); }
  }
  return names;
}

/** @param {string} s */
const className = (s) => s.split('.').pop().replace(/<\d+>$/, '');

/**
 * @typedef {{ repo: string, path: string, key: string, name: string, offset: number, line: number, mods: string[], attrs: string[],
 *   cls: string, expected: string[], text: string, blanked: string, classAttrs: string, classBases: string[] }} Row
 */

/** `facts.csControllerRoutes` as the gatherer builds it, from the blobs at the commit. @param {{ dir: string, commit: string }} repo */
function controllerRoutesAt(repo) {
  const listed = execFileSync('git', ['-C', repo.dir, 'ls-tree', '-r', '--name-only', repo.commit], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter((f) => /Controller[^/]*\.cs$/i.test(f));
  const texts = readBlobs(repo.dir, repo.commit, listed);
  /** @type {Map<string, { route: string|null, base: string|null, mvc: boolean }>} */
  const out = new Map();
  for (const [, text] of texts) for (const c of classRoutesOf(text, blank(text))) if (!out.has(c.name)) out.set(c.name, { route: c.route, base: c.base, mvc: c.mvc });
  return out;
}

/** @param {{ name: string, dir: string, commit: string, cache: string }} repo @returns {Row[]} */
function rowsOf(repo) {
  const oracle = JSON.parse(fs.readFileSync(path.join(CACHE, repo.cache), 'utf8'));
  const files = oracle.files.filter((/** @type {any} */ f) => f.members.some((/** @type {any} */ m) => m.kind === 'method'));
  const texts = readBlobs(repo.dir, oracle.commit, files.map((/** @type {any} */ f) => f.path));
  // Every class of the files read, for base chains (first declaration of a name wins).
  /** @type {Map<string, LineClass>} */
  const allClasses = new Map();
  for (const t of texts.values()) for (const [n, c] of classesByLines(t)) if (!allClasses.has(n)) allClasses.set(n, c);
  /** @param {string} name */
  const chainIsMvc = (name) => {
    for (let g = 0; g < 6; g++) {
      if (name === 'Controller' || name === 'ControllerBase') return true;
      const c = allClasses.get(name);
      if (!c) return false;
      if (c.mvcFile || /\[\s*(ApiController|Controller)\b/.test(c.attrs)) return true;
      const next = c.bases.map(baseId).find((x) => !/^I[A-Z]/.test(x));
      if (!next) return false;
      name = next;
    }
    return false;
  };
  /** @type {Row[]} */
  const rows = [];
  for (const f of files) {
    const text = texts.get(f.path);
    if (text === undefined) continue;
    const classes = classesByLines(text);
    /** Class name -> whether any of its methods (oracle) carries an MVC routing attribute. */
    const mvcAttrIn = new Set(f.members.filter((/** @type {any} */ x) => x.attributes.some((/** @type {string} */ a) => /^(?:Http(?:Get|Post|Put|Delete|Patch|Head|Options)|Route|AcceptVerbs|ApiController)\b/.test(a.replace(/^.*\./, '')))).map((/** @type {any} */ x) => className(x.container || '')));
    const handlers = mapHandlerNames(text);
    const blanked = blank(text);
    for (const m of f.members) {
      if (m.kind !== 'method') continue;
      const cn = className(m.container || '');
      const cls = classes.get(cn);
      const bases = cls ? cls.bases : [];
      const baseIds = bases.map(baseId);
      const attrs = /** @type {string[]} */ (m.attributes);
      const mods = /** @type {string[]} */ (m.modifiers);
      const expected = [];
      const framework = baseIds.some((b) => b === 'Controller' || b === 'ControllerBase');
      const namedBase = baseIds.find((b) => !/^I[A-Z]/.test(b) && /Controller(Base)?$/.test(b));
      const evidence = cls && (cls.mvcFile || /\[\s*(Route|ApiController)\b/.test(cls.attrs) || mvcAttrIn.has(cn) || (!!namedBase && chainIsMvc(namedBase)));
      const isController = cls && !/\bNonController\b/.test(cls.attrs) && !cls.abstract && !cls.generic
        && (/\[\s*(ApiController|Controller)\b/.test(cls.attrs) || framework || (evidence && ((!bases.length && /Controller$/.test(cn)) || !!namedBase)));
      const notAction = (m.typeParameters && m.typeParameters.length) || /^(OnActionExecuting|OnActionExecuted|OnActionExecutionAsync|Dispose|ToString|Equals|GetHashCode)$/.test(m.name)
        || (mods.includes('override') && framework);
      if (isController && !notAction && mods.includes('public') && !mods.includes('static') && !attrs.some((a) => /\bNonAction\b/.test(a))) expected.push('controller');
      if (handlers.has(m.name)) expected.push('minimal');
      if (cls && mods.includes('override') && m.params.some((/** @type {any} */ p) => /\bServerCallContext\b/.test(p.type)) && bases.some((b) => { const q = /^(?:\w+\.)*(\w+)\.(\w+)/.exec(b); return q && q[2] === `${q[1]}Base`; })) expected.push('grpc');
      if (cls && m.name === 'ExecuteAsync' && baseIds.includes('BackgroundService')) expected.push('hosted');
      if (cls && (m.name === 'StartAsync' || m.name === 'StopAsync') && baseIds.includes('IHostedService')) expected.push('hosted');
      if (cls && m.name === 'Handle' && baseIds.includes('IIntegrationEventHandler')) expected.push('integration');
      if (cls && baseIds.includes('Hub') && mods.includes('public') && !mods.includes('static')
        && (/^\s*using\s+Microsoft\.AspNetCore\.SignalR\s*;/m.test(text) || bases.some((b) => /^(?:global::)?Microsoft\.AspNetCore\.SignalR\.Hub\b/.test(b)))) expected.push('hub');
      if (cls && m.name === 'Handle' && baseIds.some((b) => b === 'IRequestHandler' || b === 'INotificationHandler')) expected.push('mediatr');
      if (m.name === 'Main' && mods.includes('static')) expected.push('main');
      rows.push({
        repo: repo.name, path: f.path, key: m.key, name: m.name, offset: m.nameOffset, line: m.startLine, mods, attrs, cls: cn, expected,
        text, blanked, classAttrs: cls ? cls.attrs : '', classBases: bases,
      });
    }
  }
  return rows;
}

/** The kind a rule's entry belongs to, comparable with `expected`. @param {import('../../src/engine/entry-points').EntryInfo|null} e */
function kindOf(e) {
  if (!e) return null;
  if (e.type === 'http' && e.method === 'GRPC') return 'grpc';
  if (e.type === 'http' && /registration|in this file/.test(e.how)) return 'minimal';
  if (e.type === 'http') return 'controller';
  if (e.type === 'job') return 'hosted';
  if (e.type === 'event') return /IIntegrationEventHandler/.test(e.how) ? 'integration' : 'hub';
  if (e.type === 'main') return 'main';
  return e.type;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  /** @type {Row[]} */
  let all = [];
  /** @type {Record<string, import('../../src/engine/entry-points').EntryFacts>} */
  const facts = {};
  for (const r of REPOS) {
    if (args.dirs[r.name]) r.dir = args.dirs[r.name];
    all = all.concat(rowsOf(r));
    facts[r.name] = { csControllerRoutes: controllerRoutesAt(r) };
  }
  const tRead = Date.now() - t0;
  // Offsets must land on the name: the oracle's UTF-16 offsets against the texts read here.
  const badOffsets = all.filter((r) => !r.text.startsWith(r.name, r.offset)).length;

  /** @type {Map<Row, { e: import('../../src/engine/entry-points').EntryInfo|null, k: string|null, mediatr: string|null }>} */
  const got = new Map();
  for (const r of all) {
    const e = declarationEntry({ language: 'csharp', text: r.text, blanked: r.blanked, pos: r.offset, label: r.key, relPath: r.path, facts: facts[r.repo] });
    const mediatr = unreachableReason({ text: r.text, blanked: r.blanked, pos: r.offset, label: r.key, relPath: r.path });
    got.set(r, { e, k: kindOf(e), mediatr });
  }
  const tRun = Date.now() - t0 - tRead;

  let failed = false;
  /** @type {string[]} */
  const lines0 = [];
  console.log(`rows: ${all.length} methods (${REPOS.map((r) => `${r.name} ${all.filter((x) => x.repo === r.name).length}`).join(', ')}); oracle offsets not on the name: ${badOffsets}`);
  const cats = ['controller', 'minimal', 'grpc', 'hosted', 'integration', 'hub', 'main'];
  for (const repo of REPOS.map((r) => r.name)) {
    for (const cat of cats) {
      const exp = all.filter((r) => r.repo === repo && r.expected.includes(cat));
      const gotCat = all.filter((r) => r.repo === repo && got.get(r).k === cat);
      const missing = exp.filter((r) => got.get(r).k !== cat);
      const extra = gotCat.filter((r) => !r.expected.includes(cat));
      if (!exp.length && !gotCat.length) continue;
      if (missing.length || extra.length) failed = true;
      console.log(`${repo} ${cat}: expected ${exp.length}, got ${gotCat.length}, missing ${missing.length}, extra ${extra.length}`);
      for (const r of missing.slice(0, 5)) console.log(`   missing ${r.path}:${r.line} ${r.key.slice(0, 80)} -> ${JSON.stringify(got.get(r).e)}`);
      for (const r of extra.slice(0, 5)) console.log(`   extra   ${r.path}:${r.line} ${r.key.slice(0, 80)} -> ${JSON.stringify(got.get(r).e)}`);
    }
    const med = all.filter((r) => r.repo === repo && r.expected.includes('mediatr'));
    const medGot = med.filter((r) => got.get(r).mediatr);
    const medExtra = all.filter((r) => r.repo === repo && got.get(r).mediatr && !r.expected.includes('mediatr'));
    if (med.length || medExtra.length) { if (medGot.length !== med.length || medExtra.length) failed = true; console.log(`${repo} mediatr (unreachable reason): expected ${med.length}, got ${medGot.length}, extra ${medExtra.length}`); }
  }
  // Lambda registrations (call-site entries): every `.MapX("/r", … => … Call(…) …)` of eShop whose handler is
  // a lambda; the first call inside its body must make the enclosing method an http entry of that verb.
  const lambdaRows = [];
  for (const r of all.filter((x, i, arr) => x.repo === 'eshop' && arr.findIndex((y) => y.path === x.path) === i)) {
    const noStr = r.blanked;
    const re = /\.\s*(MapGet|MapPost|MapPut|MapDelete|MapPatch)\s*\(/g;
    let m;
    while ((m = re.exec(noStr))) {
      const open = m.index + m[0].length - 1;
      const arrow = noStr.indexOf('=>', open);
      const semi = noStr.indexOf(';', open);
      if (arrow < 0 || (semi >= 0 && arrow > semi)) continue;
      // a lambda handler: `=>` directly in this call's arguments (before any `)` closing it at depth 0)
      let d = 0; let end = open;
      for (; end < noStr.length; end++) { if (noStr[end] === '(') d++; else if (noStr[end] === ')' && --d === 0) break; }
      if (arrow > end) continue;
      const call = /\b([A-Za-z_]\w*)\s*\(/g;
      call.lastIndex = arrow + 2;
      let c; let site = -1;
      while ((c = call.exec(noStr)) && c.index < end) { if (!/^(if|while|for|foreach|switch|using|new|typeof|nameof|await|return|catch)$/.test(c[1]) && c.index > arrow) { site = c.index; break; } }
      if (site < 0) continue;
      const owner = all.filter((x) => x.path === r.path && x.offset < open).sort((a, b) => b.offset - a.offset)[0];
      const callerPos = owner ? owner.offset : 0;
      const e = callSiteEntry({ language: 'csharp', text: r.text, blanked: r.blanked, callerPos, callSiteStart: site, relPath: r.path, callerLabel: 'x' });
      lambdaRows.push({ r, e, verb: m[1].slice(3).toUpperCase() });
    }
  }
  const lambdaBad = lambdaRows.filter((x) => !x.e || x.e.method !== x.verb);
  console.log(`lambda registrations in eshop: ${lambdaRows.length}, call-site entry with the verb: ${lambdaRows.length - lambdaBad.length}, not: ${lambdaBad.length}`);
  if (lambdaBad.length) failed = true;
  for (const x of lambdaRows) lines0.push(`eshop ${x.r.path} (lambda) | ${shown(x.e)}`);
  // Rows that got an entry without any expectation, any kind.
  const unexpected = all.filter((r) => got.get(r).e && !r.expected.length);
  console.log(`entries on methods with no expectation: ${unexpected.length}`);
  for (const r of unexpected.slice(0, 8)) console.log(`   ${r.path}:${r.line} ${r.key.slice(0, 80)} -> ${JSON.stringify(got.get(r).e)}`);
  if (unexpected.length) failed = true;
  // An expected entry that has two kinds (a minimal-API handler in a controller class...) is fine.

  // Negative sample: methods that are no expected entry, every k-th in file order.
  const negatives = all.filter((r) => !r.expected.length);
  const step = Math.max(1, Math.floor(negatives.length / NEGATIVE_SAMPLE));
  const sample = negatives.filter((_, i) => i % step === 0).slice(0, NEGATIVE_SAMPLE);
  const sampleHttp = sample.filter((r) => got.get(r).e && got.get(r).e.type === 'http');
  console.log(`negative sample: ${sample.length} of ${negatives.length} non-entry methods (every ${step}th), http: ${sampleHttp.length}, any entry: ${sample.filter((r) => got.get(r).e).length}`);
  if (sampleHttp.length) failed = true;
  // The same over all of them.
  const negHttp = negatives.filter((r) => got.get(r).e && got.get(r).e.type === 'http');
  console.log(`all ${negatives.length} non-entry methods: http ${negHttp.length}`);

  // C-D9: routes to check by hand.
  const lines = [];
  const actions = all.filter((r) => r.repo === 'jellyfin' && r.expected.includes('controller'));
  const astep = Math.max(1, Math.floor(actions.length / ACTION_SAMPLE));
  const picked = actions.filter((_, i) => i % astep === 0).slice(0, ACTION_SAMPLE);
  lines.push(`# C-D9 route sample: ${picked.length} of ${actions.length} jellyfin controller actions (every ${astep}th in file order), then all eShop minimal-API handlers`);
  lines.push('# file:line | class attributes | method attributes | route computed');
  for (const r of picked) lines.push(`jellyfin ${r.path}:${r.line} | class ${r.cls}: ${r.classAttrs.replace(/\s+/g, ' ')} | ${r.attrs.join(' ')} | ${shown(got.get(r).e)}`);
  const minimal = all.filter((r) => r.repo === 'eshop' && r.expected.includes('minimal'));
  lines.push(`# eShop minimal-API handlers: ${minimal.length}`);
  for (const r of minimal) {
    const callLine = r.text.split('\n').findIndex((l) => new RegExp(`\\.Map\\w+\\([^;]*\\b${r.name}\\b`).test(l)) + 1;
    lines.push(`eshop ${r.path}:${r.line} (registered near line ${callLine || '?'}) | ${r.name} | ${shown(got.get(r).e)}`);
  }
  lines.push('# eShop lambda handlers (call-site entries, first call in the lambda)', ...lines0);
  const mvc = all.filter((r) => r.repo === 'eshop' && r.expected.includes('controller'));
  lines.push(`# eShop MVC controller actions: ${mvc.length} (Identity.API: conventional routes, app.MapDefaultControllerRoute())`);
  for (const r of mvc) lines.push(`eshop ${r.path}:${r.line} | ${r.cls}.${r.name} | ${r.attrs.join(' ')} | ${got.get(r).e ? `${shown(got.get(r).e)} [${got.get(r).e.how}]` : '(no entry)'}`);
  const text = `${lines.join('\n')}\n`;
  if (args.sampleOut) { fs.writeFileSync(args.sampleOut, text); console.log(`route sample written to ${args.sampleOut}`); }
  if (args.updateRoutes) { fs.writeFileSync(ROUTES_FILE, text); console.log(`route sample written to ${ROUTES_FILE}`); }
  else {
    const want = fs.existsSync(ROUTES_FILE) ? fs.readFileSync(ROUTES_FILE, 'utf8').split('\n') : [];
    const have = text.split('\n');
    const diff = [];
    for (let i = 0; i < Math.max(want.length, have.length); i++) if (want[i] !== have[i]) diff.push(`   line ${i + 1}\n     checked: ${want[i] ?? '(none)'}\n     now:     ${have[i] ?? '(none)'}`);
    console.log(`route sample vs ${path.basename(ROUTES_FILE)}: ${diff.length ? `${diff.length} line(s) differ` : 'same'}`);
    for (const d of diff.slice(0, 10)) console.log(d);
    if (diff.length) failed = true;
  }
  console.log(`read ${tRead} ms, rules ${tRun} ms, total ${Date.now() - t0} ms`);
  process.exit(failed ? 1 : 0);
}

main();
