'use strict';

/**
 * P0 spike: what Pyright gives us on encode/httpx, answered through the harness.
 *
 *   node test/lsp-harness/p0-spike.js <httpx clone> [--pyright <path to pyright-langserver>]
 *     [--python <interpreter>]
 *
 * `--python` is sent as the `python.pythonPath` setting (e.g. a bare `python3 -m venv
 * --without-pip` interpreter, to see answers without the third-party packages installed);
 * without it Pyright picks `python3` from PATH and its site-packages.
 *
 * The default server is the MIT `pyright` npm package installed per P-D1 in
 * ~/Projects/impact-tree-scratchpad/py-tools. The clone is untrusted: its code is never run
 * (Python is only used, isolated with `-I` and outside the clone, to parse texts with `ast`).
 * One scratch module is written under httpx/ before the server starts and removed on exit,
 * as is a temporary directory under os.tmpdir(). Report to stdout, progress to stderr. The
 * whole run is bounded by OVERALL_DEADLINE_MS, each request by REQUEST_DEADLINE_MS, and the
 * server is killed on exit.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { LspClient } = require('./lsp-client');
const { offsetToPosition, positionToOffset, SYMBOL_KINDS } = require('./gopls-services');

/** Whole run, ms; past it the server is killed and every pending request fails. */
const OVERALL_DEADLINE_MS = 2 * 60 * 1000;
/** One LSP request, ms. Pyright's cold workspace-wide incomingCalls is the slowest. */
const REQUEST_DEADLINE_MS = 30000;
/** git and python child processes, ms. */
const CHILD_DEADLINE_MS = 20000;
/** Queries per warm timing row. */
const WARM_QUERIES = 10;
/** Most `.py` files read for the duck-typing text search; more fails the run. */
const MAX_PY_FILES = 1000;
/** Most characters of one `.py` file read for the text search; larger files fail the run. */
const MAX_PY_FILE_CHARS = 2 * 1024 * 1024;
/** Most text hits classified with `definition` per method; the rest are counted, not classified. */
const MAX_HITS_CLASSIFIED = 200;
/** Base-side ref: the parent of 15e21e9 (Client docstring change, #3426), i.e. 0.28.0. */
const BASE_REF = '15e21e9^';
const SCRATCH_REL = 'httpx/_zz_it_p0_scratch.py';
const DEFAULT_PYRIGHT = path.join(os.homedir(), 'Projects', 'impact-tree-scratchpad', 'py-tools',
  'node_modules', '.bin', 'pyright-langserver');

/** Cases the repository lacks: decorator registration, dict storage, untyped receivers, etc. */
const SCRATCH_TEXT = `# impact-tree P0 scratch module; written by test/lsp-harness/p0-spike.js and removed on exit.
import typing

from httpx._models import Response

REGISTRY = {}


def register(fn):
    REGISTRY[fn.__name__] = fn
    return fn


@register
def registered_handler(x: int) -> int:
    return x


def stored_in_dict(x: int) -> int:
    return x


HANDLERS = {"a": stored_in_dict}


def passed_as_callback(x: int) -> int:
    return x


def run_callbacks() -> list:
    return list(map(passed_as_callback, [1, 2]))


def call_untyped(resp):
    return resp.raise_for_status()


def call_annotated(resp: Response):
    return resp.raise_for_status()


class Tool:
    @staticmethod
    def make() -> "Tool":
        return Tool()

    @classmethod
    def build(cls) -> "Tool":
        return cls.make()

    @typing.overload
    def get(self, key: int) -> int: ...
    @typing.overload
    def get(self, key: str) -> str: ...
    def get(self, key):
        return key

    def outer(self) -> int:
        def inner() -> int:
            return 1

        return inner()

    def duck(self) -> int:
        return 1


class Other:
    def duck(self) -> int:
        return 2


def use_tools(t: Tool, anything) -> None:
    Tool.make()
    Tool.build()
    t.get(1)
    t.duck()
    anything.duck()
    Other().duck()
`;

/**
 * Prints every FunctionDef/AsyncFunctionDef of each named text as JSON. Input on stdin:
 * {"<key>": "<python source>"}; output {"<key>": [{name, qual, line, decoLine, endLine,
 * inFunction, decorators, docstring}]}. Lines are 1-based.
 */
const AST_DEFS_PY = `
import ast, json, sys
out = {}
for key, text in json.load(sys.stdin).items():
    defs = []
    def walk(node, quals, in_func):
        for c in ast.iter_child_nodes(node):
            if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs.append({"name": c.name, "qual": ".".join(quals + [c.name]), "line": c.lineno,
                    "decoLine": min([d.lineno for d in c.decorator_list] + [c.lineno]),
                    "endLine": c.end_lineno, "inFunction": in_func,
                    "decorators": [ast.unparse(d) for d in c.decorator_list],
                    "docstring": ast.get_docstring(c) is not None})
                walk(c, quals + [c.name], True)
            elif isinstance(c, ast.ClassDef):
                walk(c, quals + [c.name], in_func)
            else:
                walk(c, quals, in_func)
    walk(ast.parse(text), [], False)
    out[key] = defs
json.dump(out, sys.stdout)
`;

/**
 * Prints the string and comment token spans of each named text as JSON. Input on stdin:
 * {"<key>": "<python source>"}; output {"<key>": [[startLine, startCol, endLine, endCol]]},
 * lines 1-based, columns in code points (equal to UTF-16 units outside astral characters).
 */
const STRING_SPANS_PY = `
import io, json, sys, tokenize
kinds = {tokenize.STRING, tokenize.COMMENT, getattr(tokenize, "FSTRING_MIDDLE", -1)}
out = {}
for key, text in json.load(sys.stdin).items():
    spans = []
    for tok in tokenize.generate_tokens(io.StringIO(text).readline):
        if tok.type in kinds:
            spans.append([tok.start[0], tok.start[1], tok.end[0], tok.end[1]])
    out[key] = spans
json.dump(out, sys.stdout)
`;

/**
 * @typedef {{ start: number, end: number }} OffsetRange
 * @typedef {{ name: string, detail: string, kindName: string, range: OffsetRange,
 *   selectionRange: OffsetRange, children: Sym[], parent: Sym|null }} Sym
 * @typedef {{ name: string, qual: string, line: number, decoLine: number, endLine: number,
 *   inFunction: boolean, decorators: string[], docstring: boolean }} AstDef
 * @typedef {{ uri: string, text: string }} Doc
 */

const startedAt = Date.now();
/** @type {string[]} */
const report = [];
/** @param {string} [line] */
function say(line = '') { report.push(line); }
/** @param {string} line */
function progress(line) { process.stderr.write(`[p0 ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${line}\n`); }

/**
 * @template T @param {() => Promise<T>} fn
 * @returns {Promise<{ ms: number, value?: T, error?: Error }>}
 */
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
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** @param {number} ms */
function fmt(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`; }

/** @param {string} text @param {number} off 1-based line of an offset */
function lineOf(text, off) { return offsetToPosition(text, off).line + 1; }

/** @param {string} cwd @param {string[]} args @returns {Promise<string>} */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: CHILD_DEADLINE_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/**
 * Parses texts with Python's ast, isolated (-I) and run from os.tmpdir(), never the clone.
 * @param {Record<string, string>} texts @returns {Promise<Record<string, AstDef[]>>}
 */
function astDefs(texts) { return runPython(AST_DEFS_PY, texts); }

/**
 * Runs a fixed Python snippet (isolated, from os.tmpdir()) on JSON stdin; parses its JSON stdout.
 * @param {string} code @param {Record<string, string>} texts @returns {Promise<any>}
 */
function runPython(code, texts) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-I', '-c', code], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => proc.kill('SIGKILL'), CHILD_DEADLINE_MS);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`python3 ast exited ${code} ${signal}: ${err.slice(-500)}`)); return; }
      resolve(JSON.parse(out));
    });
    proc.stdin.end(JSON.stringify(texts));
  });
}

/**
 * The few LSP operations the spike needs, on Pyright. Offsets are UTF-16 indices into the
 * document text. `null` is the server's own null; failures reject.
 * @param {{ repo: string, command: string, pythonPath: string|null }} options
 */
function createPyrightServices(options) {
  /** @type {Map<string, string>} uri -> text sent with didOpen */
  const open = new Map();
  /** @type {Map<string, string>} uri -> text read from disk for answers in unopened files */
  const disk = new Map();
  /** @type {string[]} */
  const logs = [];
  /** @type {Map<string, any[]>} uri -> latest published diagnostics */
  const diagnostics = new Map();
  const client = new LspClient({
    command: options.command,
    args: ['--stdio'],
    cwd: options.repo,
    onNotification: (method, params) => {
      if (method === 'window/logMessage' && logs.length < 400) logs.push(String(params && params.message));
      if (method === 'textDocument/publishDiagnostics' && params) diagnostics.set(params.uri, params.diagnostics || []);
    },
  });

  client.requestHandlers['workspace/configuration'] = (/** @type {any} */ params) => (params.items || []).map(
    (/** @type {any} */ item) => (item.section === 'python' && options.pythonPath ? { pythonPath: options.pythonPath } : null));

  /** @param {Doc} doc */
  function ensureOpen(doc) {
    const known = open.get(doc.uri);
    if (known === doc.text) return;
    if (known !== undefined) client.didClose(doc.uri);
    client.didOpen({ uri: doc.uri, languageId: 'python', text: doc.text });
    open.set(doc.uri, doc.text);
  }

  /** @param {string} uri */
  function textOf(uri) {
    const opened = open.get(uri);
    if (opened !== undefined) return opened;
    let text = disk.get(uri);
    if (text === undefined) {
      text = fs.readFileSync(fileURLToPath(uri), 'utf8'); // throws: no silent empty text
      disk.set(uri, text);
    }
    return text;
  }

  /** @param {string} uri @param {any} r @returns {OffsetRange} */
  function offsets(uri, r) {
    const text = textOf(uri);
    return { start: positionToOffset(text, r.start), end: positionToOffset(text, r.end) };
  }

  /** @param {string} uri @param {any} raw @param {Sym|null} parent @returns {Sym} */
  function convertSymbol(uri, raw, parent) {
    if (!raw.range || !raw.selectionRange) throw new Error(`flat SymbolInformation for ${uri}, not DocumentSymbol`);
    /** @type {Sym} */
    const sym = {
      name: raw.name, detail: raw.detail || '', kindName: SYMBOL_KINDS[raw.kind] || String(raw.kind),
      range: offsets(uri, raw.range), selectionRange: offsets(uri, raw.selectionRange), children: [], parent,
    };
    sym.children = (raw.children || []).map((c) => convertSymbol(uri, c, sym));
    return sym;
  }

  /** @param {Doc} doc @param {number} pos */
  function at(doc, pos) {
    ensureOpen(doc);
    return { textDocument: { uri: doc.uri }, position: offsetToPosition(doc.text, pos) };
  }

  return {
    client,
    logs,
    textOf,
    start: () => client.initialize({ rootPath: options.repo, rootUri: pathToFileURL(options.repo).toString(), deadlineMs: REQUEST_DEADLINE_MS }),
    /** @param {Doc} doc @returns {Promise<Sym[]|null>} */
    async documentSymbols(doc) {
      ensureOpen(doc);
      const result = await client.request('textDocument/documentSymbol', { textDocument: { uri: doc.uri } }, REQUEST_DEADLINE_MS);
      return result === null ? null : result.map((/** @type {any} */ s) => convertSymbol(doc.uri, s, null));
    },
    /** @param {Doc} doc @param {number} pos @returns {Promise<any[]|null>} raw CallHierarchyItems */
    prepare: (doc, pos) => client.request('textDocument/prepareCallHierarchy', at(doc, pos), REQUEST_DEADLINE_MS),
    /**
     * @param {any} item
     * @returns {Promise<{ name: string, uri: string, kindName: string, fromRanges: OffsetRange[] }[]|null>}
     */
    async incoming(item) {
      const result = await client.request('callHierarchy/incomingCalls', { item }, REQUEST_DEADLINE_MS);
      if (result === null) return null;
      return result.map((/** @type {any} */ c) => ({
        name: c.from.name, uri: c.from.uri, kindName: SYMBOL_KINDS[c.from.kind] || String(c.from.kind),
        fromRanges: c.fromRanges.map((/** @type {any} */ r) => offsets(c.from.uri, r)),
      }));
    },
    /** @param {Doc} doc @param {number} pos @returns {Promise<{ uri: string, start: number }[]|null>} */
    async references(doc, pos) {
      const result = await client.request('textDocument/references', { ...at(doc, pos), context: { includeDeclaration: false } }, REQUEST_DEADLINE_MS);
      return result === null ? null : result.map((/** @type {any} */ l) => ({ uri: l.uri, start: offsets(l.uri, l.range).start }));
    },
    /** @param {Doc} doc @param {number} pos @returns {Promise<{ uri: string, start: number }[]|null>} */
    async definition(doc, pos) {
      const result = await client.request('textDocument/definition', at(doc, pos), REQUEST_DEADLINE_MS);
      if (result === null) return null;
      const list = Array.isArray(result) ? result : [result];
      return list.map((/** @type {any} */ l) => {
        const uri = l.targetUri || l.uri;
        return { uri, start: offsets(uri, l.targetSelectionRange || l.range).start };
      });
    },
    /** @param {string} uri */
    closeDoc(uri) { if (open.delete(uri)) client.didClose(uri); },
    diagnostics,
    close: () => client.close(),
  };
}

/** @param {Sym[]} syms @returns {Sym[]} every symbol, depth first */
function flatten(syms) {
  /** @type {Sym[]} */
  const out = [];
  const stack = [...syms].reverse();
  while (stack.length) {
    const s = /** @type {Sym} */ (stack.pop());
    out.push(s);
    for (let i = s.children.length - 1; i >= 0; i--) stack.push(s.children[i]);
  }
  return out;
}

/** @param {string} text @param {number} line1 @param {string} name offset of `def name` on a 1-based line */
function defNameOffset(text, line1, name) {
  const lineStart = positionToOffset(text, { line: line1 - 1, character: 0 });
  const m = new RegExp(`def\\s+${name}\\b`).exec(text.slice(lineStart, lineStart + 400));
  if (!m) throw new Error(`no "def ${name}" on line ${line1}`);
  return lineStart + m.index + m[0].length - name.length;
}

async function main() {
  const args = process.argv.slice(2);
  const repo = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pyright' && args[i - 1] !== '--python');
  const yi = args.indexOf('--python');
  const pythonPath = yi >= 0 ? args[yi + 1] : null;
  if (yi >= 0 && (!pythonPath || !fs.existsSync(pythonPath))) throw new Error(`--python interpreter not found: ${pythonPath}`);
  const pi = args.indexOf('--pyright');
  const pyright = pi >= 0 ? args[pi + 1] : DEFAULT_PYRIGHT;
  if (!repo || !path.isAbsolute(repo)) throw new Error('usage: node p0-spike.js <absolute path to httpx clone> [--pyright path]');
  if (!pyright || !fs.existsSync(pyright)) throw new Error(`pyright-langserver not found at ${pyright}`);

  const pyrightPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(pyright)), 'package.json'), 'utf8'));
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const pyVersion = await new Promise((resolve, reject) => {
    execFile('python3', ['-I', '--version'], { cwd: os.tmpdir(), timeout: CHILD_DEADLINE_MS }, (e, out) => (e ? reject(e) : resolve(out.trim())));
  });
  say('# P0 spike measurements');
  say(`machine: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0].model}, ${os.cpus().length} cpus, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB`);
  say(`pyright ${pyrightPkg.version} (${pyright}); node ${process.version}; ${pyVersion} (ast only); httpx @ ${head}`);
  say(`python environment given to pyright: ${pythonPath ? `python.pythonPath=${pythonPath}` : 'none (pyright uses python3 from PATH)'}`);
  say('');

  const file = (/** @type {string} */ p) => path.join(repo, p);
  const uriOf = (/** @type {string} */ p) => pathToFileURL(file(p)).toString();
  const scratchPath = file(SCRATCH_REL);
  if (fs.existsSync(scratchPath)) throw new Error(`${scratchPath} already exists; refusing to overwrite it`);
  fs.writeFileSync(scratchPath, SCRATCH_TEXT, 'utf8'); // before the server starts, so its workspace scan sees it
  let tmpDir = /** @type {string|null} */ (null);
  const services = createPyrightServices({ repo, command: pyright, pythonPath });
  const killTimer = setTimeout(() => { progress('overall deadline hit, killing pyright'); services.client.proc.kill('SIGKILL'); }, OVERALL_DEADLINE_MS);

  try {
    const tInit = await timed(() => services.start());
    if (tInit.error) throw tInit.error;
    progress(`initialized in ${fmt(tInit.ms)}`);
    /** @type {Map<string, Doc>} */
    const docs = new Map();
    const doc = (/** @type {string} */ p) => {
      let d = docs.get(p);
      if (!d) { d = { uri: uriOf(p), text: fs.readFileSync(file(p), 'utf8') }; docs.set(p, d); }
      return d;
    };
    const symFiles = ['httpx/_client.py', 'httpx/_models.py', 'httpx/_auth.py', 'httpx/_status_codes.py', SCRATCH_REL];
    const astOnlyFiles = ['httpx/_api.py', 'httpx/_main.py'];
    const baseText = await git(repo, ['show', `${BASE_REF}:httpx/_client.py`]);
    const astTexts = /** @type {Record<string, string>} */ ({ base: baseText });
    for (const p of [...symFiles, ...astOnlyFiles]) astTexts[p] = doc(p).text;
    const ast = await astDefs(astTexts);

    // ---- 6a. cold timings --------------------------------------------------
    const cold = await timed(() => services.documentSymbols(doc('httpx/_client.py')));
    if (cold.error) throw cold.error;
    progress(`first documentSymbol ${fmt(cold.ms)}`);
    /** @type {Map<string, Sym[]>} */
    const symsOf = new Map([['httpx/_client.py', /** @type {Sym[]} */ (cold.value)]]);
    const findSym = (/** @type {string} */ p, /** @type {string} */ qual, nth = 1) => {
      const def = ast[p].filter((d) => d.qual === qual)[nth - 1];
      if (!def) throw new Error(`no def ${qual} #${nth} in ${p}`);
      return { def, pos: defNameOffset(doc(p).text, def.line, def.name) };
    };
    const t0 = findSym('httpx/_models.py', 'Response.raise_for_status');
    const coldPrep = await timed(() => services.prepare(doc('httpx/_models.py'), t0.pos));
    if (coldPrep.error) throw coldPrep.error;
    const coldInc = await timed(() => services.incoming(/** @type {any[]} */ (coldPrep.value)[0]));
    if (coldInc.error) throw coldInc.error;
    progress(`first incomingCalls ${fmt(coldInc.ms)}`);

    // ---- 1. documentSymbol ---------------------------------------------------
    say('## 1. documentSymbol vs ast');
    for (const p of symFiles) {
      let syms = symsOf.get(p);
      if (!syms) {
        const r = await services.documentSymbols(doc(p));
        if (r === null) { say(`- ${p}: null`); continue; }
        syms = r;
        symsOf.set(p, syms);
      }
      const text = doc(p).text;
      const all = flatten(syms);
      const kinds = /** @type {Record<string, number>} */ ({});
      for (const s of all) kinds[s.kindName] = (kinds[s.kindName] || 0) + 1;
      const defs = ast[p];
      /** @type {Record<string, Record<string, number>>} */
      const byCat = {};
      let matched = 0; let parentOk = 0; let startAtDef = 0; let startAtDeco = 0; let decorated = 0;
      let endOk = 0; let selIsName = 0; let withDoc = 0; let docInside = 0;
      /** @type {string[]} */
      const missing = [];
      for (const d of defs) {
        const sym = all.find((s) => lineOf(text, s.selectionRange.start) === d.line && text.slice(s.selectionRange.start, s.selectionRange.end) === d.name);
        const cat = d.inFunction ? 'nested def' : d.decorators.includes('property') || d.decorators.some((x) => x.endsWith('.setter')) ? 'property/setter'
          : d.decorators.includes('classmethod') ? 'classmethod' : d.decorators.includes('staticmethod') ? 'staticmethod'
            : d.qual.includes('.') ? 'method' : 'function';
        byCat[cat] = byCat[cat] || {};
        if (!sym) {
          byCat[cat].MISSING = (byCat[cat].MISSING || 0) + 1;
          const parentName = d.qual.split('.').slice(-2, -1)[0];
          const kept = all.filter((s) => s.name === d.name && (s.parent ? s.parent.name : undefined) === parentName && /Method|Function/.test(s.kindName));
          missing.push(`${d.qual}:${d.line} [${d.decorators.join(',') || 'no decorator'}] (same-name symbol: ${kept.map((k) => `def line ${lineOf(text, k.selectionRange.start)}, range lines ${lineOf(text, k.range.start)}-${lineOf(text, k.range.end)}`).join('; ') || 'none'})`);
          continue;
        }
        matched++;
        byCat[cat][sym.kindName] = (byCat[cat][sym.kindName] || 0) + 1;
        const parentName = d.qual.split('.').slice(-2, -1)[0];
        if (parentName ? sym.parent && sym.parent.name === parentName : !sym.parent) parentOk++;
        const startLine = lineOf(text, sym.range.start);
        if (startLine === d.line) startAtDef++;
        if (d.decoLine < d.line) { decorated++; if (startLine === d.decoLine) startAtDeco++; }
        if (lineOf(text, Math.max(sym.range.start, sym.range.end - 1)) === d.endLine) endOk++;
        if (text.slice(sym.selectionRange.start, sym.selectionRange.end) === sym.name) selIsName++;
        if (d.docstring) { withDoc++; if (lineOf(text, sym.range.end) >= d.endLine) docInside++; }
      }
      say(`### ${p}`);
      say(`- all symbols (flattened) by kind: ${JSON.stringify(kinds)}; top level: ${syms.length}`);
      say(`- ast defs: ${defs.length}; matched to a symbol (same def line + selectionRange text = name): ${matched}${missing.length ? `; missing: ${missing.slice(0, 8).join('; ')}` : ''}`);
      say(`- symbol kind per def category: ${JSON.stringify(byCat)}`);
      say(`- parent symbol = enclosing class/def (top-level defs have none): ${parentOk}/${matched}`);
      say(`- range starts on the \`def\` line: ${startAtDef}/${matched}; decorated defs: ${decorated}, range starts on the first decorator line: ${startAtDeco}/${decorated}`);
      say(`- range ends on ast end_lineno: ${endOk}/${matched}; defs with a docstring: ${withDoc}, inside range: ${docInside}/${withDoc}; selectionRange text = name: ${selIsName}/${matched}`);
      const dupNames = /** @type {Record<string, number>} */ ({});
      for (const s of all) if (/Method|Function|Property/.test(s.kindName)) dupNames[`${s.parent ? s.parent.name + '.' : ''}${s.name}`] = (dupNames[`${s.parent ? s.parent.name + '.' : ''}${s.name}`] || 0) + 1;
      const dups = Object.entries(dupNames).filter(([, n]) => n > 1);
      say(`- same name listed more than once: ${dups.length ? dups.slice(0, 8).map(([k, n]) => `${k} x${n}`).join(', ') : 'none'}`);
      const nonDef = all.filter((s) => !/Method|Function|Property|Class|Constructor/.test(s.kindName));
      say(`- non-def symbols: ${nonDef.length}, e.g. ${nonDef.slice(0, 5).map((s) => `${s.kindName}:${s.parent ? s.parent.name + '.' : ''}${s.name}`).join(', ')}`);
      const samples = all.filter((s) => /Method|Function|Property/.test(s.kindName)).slice(0, 3);
      const details = new Set(all.filter((s) => /Method|Function|Property/.test(s.kindName)).map((s) => s.detail));
      say(`- detail on defs: ${details.size} distinct value(s): ${[...details].slice(0, 3).map((x) => JSON.stringify(x)).join(', ')}; samples: ${samples.map((s) => `${s.kindName} ${s.name} detail=${JSON.stringify(s.detail)}`).join(' | ')}`);
      const fnChildren = all.filter((s) => /Method|Function/.test(s.kindName)).flatMap((s) => s.children);
      const childKinds = /** @type {Record<string, number>} */ ({});
      for (const c of fnChildren) childKinds[c.kindName] = (childKinds[c.kindName] || 0) + 1;
      say(`- children of function/method symbols by kind (parameters and locals included?): ${JSON.stringify(childKinds)}`);
      if (p === SCRATCH_REL) {
        const tool = all.find((s) => s.name === 'Tool');
        say(`- scratch Tool children: ${tool ? tool.children.map((c) => `${c.kindName}:${c.name}[${c.children.map((g) => g.kindName + ':' + g.name).join(',')}]`).join(', ') : 'Tool not found'}`);
      }
    }
    say('');

    // ---- 2. base side ----------------------------------------------------------
    say(`## 2. Base-side documents (httpx/_client.py at ${BASE_REF})`);
    const baseDefs = ast.base;
    say(`- base text: ${baseText.length} chars, ${baseDefs.length} ast defs (head: ${ast['httpx/_client.py'].length}); differs from head: ${baseText !== doc('httpx/_client.py').text}`);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-p0-'));
    const tmpFile = path.join(tmpDir, '_client.py');
    fs.writeFileSync(tmpFile, baseText, 'utf8');
    const variants = /** @type {[string, Doc][]} */ ([
      ['(a) impacttree-base:/httpx/_client.py?ref=...', { uri: `impacttree-base:/httpx/_client.py?ref=${encodeURIComponent(BASE_REF)}`, text: baseText }],
      ['(b) untitled:Untitled-1', { uri: 'untitled:Untitled-1', text: baseText }],
      ['(c) temp file outside the workspace (os.tmpdir)', { uri: pathToFileURL(tmpFile).toString(), text: baseText }],
    ]);
    for (const [label, d] of [...variants, ...variants.map(([l, v]) => /** @type {[string, Doc]} */ ([`${l}, second time (after didClose)`, v]))]) {
      const r = await timed(() => services.documentSymbols(d));
      if (r.error) { say(`- ${label}: ERROR ${r.error.message} (${fmt(r.ms)})`); continue; }
      if (r.value === null || r.value === undefined) { say(`- ${label}: null (${fmt(r.ms)})`); continue; }
      const all = flatten(r.value);
      const ok = baseDefs.filter((bd) => all.some((s) => lineOf(baseText, s.selectionRange.start) === bd.line && s.name === bd.name)).length;
      const defSyms = all.filter((s) => /Method|Function|Property/.test(s.kindName)).length;
      say(`- ${label}: ${all.length} symbols, ${defSyms} def symbols, ${ok}/${baseDefs.length} ast defs matched at their line, ${fmt(r.ms)}`);
      const first = all.find((s) => s.kindName === 'Method');
      if (first) {
        const p = await timed(() => services.prepare(d, first.selectionRange.start));
        say(`    prepareCallHierarchy on ${first.name}: ${p.error ? 'ERROR ' + p.error.message : p.value === null ? 'null' : /** @type {any[]} */ (p.value).length + ' item(s)'} (${fmt(p.ms)})`);
      }
      services.closeDoc(d.uri);
    }
    say('');

    // ---- 3/4. call hierarchy and value uses --------------------------------------
    /**
     * @param {string} label @param {string} p @param {string} qual @param {number} [nth]
     * @returns {Promise<{ callers: NonNullable<Awaited<ReturnType<typeof services.incoming>>>, refs: number|null, pos: number }|null>}
     */
    async function callers(label, p, qual, nth = 1) {
      const { pos } = findSym(p, qual, nth);
      const d = doc(p);
      const prep = await timed(() => services.prepare(d, pos));
      if (prep.error || !prep.value || prep.value.length === 0) {
        say(`- ${label}: prepareCallHierarchy -> ${prep.error ? 'ERROR ' + prep.error.message : JSON.stringify(prep.value)} (${fmt(prep.ms)})`);
        return null;
      }
      const inc = await timed(() => services.incoming(/** @type {any[]} */ (prep.value)[0]));
      const refs = await timed(() => services.references(d, pos));
      if (inc.error) { say(`- ${label}: incomingCalls ERROR ${inc.error.message}`); return null; }
      const list = inc.value || [];
      const rawSites = list.reduce((n, c) => n + c.fromRanges.length, 0);
      const uniqueSites = new Set(list.flatMap((c) => c.fromRanges.map((r) => `${c.uri}#${r.start}`))).size;
      const seen = new Set();
      const sites = list.flatMap((c) => c.fromRanges.filter((r) => !seen.has(`${c.uri}#${r.start}`) && seen.add(`${c.uri}#${r.start}`)).map((r) => {
        const t = services.textOf(c.uri);
        const after = t.slice(r.end, r.end + 1);
        return `${c.name}@${path.relative(repo, fileURLToPath(c.uri))}:${lineOf(t, r.start)}${after === '(' ? '' : ' [mention]'}`;
      }));
      const inTests = list.filter((c) => fileURLToPath(c.uri).startsWith(path.join(repo, 'tests') + path.sep)).length;
      const refText = refs.error ? `ERROR ${refs.error.message}` : refs.value === null ? 'null' : `${/** @type {any[]} */ (refs.value).length}`;
      say(`- ${label}: ${inc.value === null ? 'null' : list.length + ' caller(s)'}, ${uniqueSites} distinct site(s) (${rawSites} fromRanges), ${inTests} caller(s) in tests/; references ${refText} (${fmt(inc.ms)} / ${fmt(refs.ms)}): ${sites.slice(0, 12).join(', ')}${sites.length > 12 ? `, ... (+${sites.length - 12})` : ''}`);
      return { callers: list, refs: refs.value ? /** @type {any[]} */ (refs.value).length : null, pos };
    }

    say('## 3. Call hierarchy');
    say(`- cold first call Response.raise_for_status: prepare ${fmt(coldPrep.ms)}, incomingCalls ${fmt(coldInc.ms)}`);
    await callers('module function httpx._api.request (re-exported as httpx.request)', 'httpx/_api.py', 'request');
    await callers('module function httpx._api.get', 'httpx/_api.py', 'get');
    await callers('method on self: BaseClient._merge_url', 'httpx/_client.py', 'BaseClient._merge_url');
    await callers('method, annotated receivers: Response.raise_for_status', 'httpx/_models.py', 'Response.raise_for_status');
    await callers('scratch Tool.duck (t: Tool, anything untyped, Other().duck)', SCRATCH_REL, 'Tool.duck');
    await callers('scratch Other.duck', SCRATCH_REL, 'Other.duck');
    await callers('@property getter Response.encoding', 'httpx/_models.py', 'Response.encoding', 1);
    await callers('@encoding.setter Response.encoding', 'httpx/_models.py', 'Response.encoding', 2);
    await callers('@property getter BaseClient.timeout', 'httpx/_client.py', 'BaseClient.timeout', 1);
    await callers('@classmethod codes.get_reason_phrase', 'httpx/_status_codes.py', 'codes.get_reason_phrase');
    await callers('scratch @staticmethod Tool.make', SCRATCH_REL, 'Tool.make');
    await callers('scratch @classmethod Tool.build', SCRATCH_REL, 'Tool.build');
    await callers('scratch @overload Tool.get #1', SCRATCH_REL, 'Tool.get', 1);
    await callers('scratch Tool.get implementation (#3)', SCRATCH_REL, 'Tool.get', 3);
    await callers('scratch nested def Tool.outer.inner', SCRATCH_REL, 'Tool.outer.inner');
    say('');

    say('## 4. Value uses ([mention] = the site is not followed by "(")');
    await callers('validate_json (click `callback=validate_json`)', 'httpx/_main.py', 'validate_json');
    await callers('trace (`functools.partial(trace, ...)` in a dict)', 'httpx/_main.py', 'trace');
    await callers('scratch registered_handler (@register decorator)', SCRATCH_REL, 'registered_handler');
    await callers('scratch stored_in_dict (HANDLERS = {"a": fn})', SCRATCH_REL, 'stored_in_dict');
    await callers('scratch passed_as_callback (map(fn, ...))', SCRATCH_REL, 'passed_as_callback');
    await callers('scratch register (used only as a decorator)', SCRATCH_REL, 'register');
    say('');

    // Opened so Pyright publishes their diagnostics (it checks open files only): they import
    // httpcore, click, rich and pygments, the third-party packages of the clone.
    const diagFiles = ['httpx/_transports/default.py', 'httpx/_main.py'];
    for (const rel of diagFiles) await services.documentSymbols(doc(rel));

    // ---- 5. duck typing ------------------------------------------------------------
    say('## 5. Duck typing: call hierarchy vs text search for `.<name>(`');
    const pyFiles = (await git(repo, ['ls-files', '*.py'])).trim().split('\n').filter(Boolean);
    pyFiles.push(SCRATCH_REL);
    if (pyFiles.length > MAX_PY_FILES) throw new Error(`${pyFiles.length} .py files exceed ${MAX_PY_FILES}`);
    const pyTexts = /** @type {Record<string, string>} */ ({});
    for (const rel of pyFiles) {
      const d = doc(rel);
      if (d.text.length > MAX_PY_FILE_CHARS) throw new Error(`${rel} has ${d.text.length} chars, above ${MAX_PY_FILE_CHARS}`);
      pyTexts[rel] = d.text;
    }
    const rawSpans = await runPython(STRING_SPANS_PY, pyTexts);
    /** @type {Map<string, OffsetRange[]>} */
    const stringSpans = new Map(Object.entries(rawSpans).map(([rel, spans]) => [rel, /** @type {number[][]} */ (spans).map(([l1, c1, l2, c2]) => ({
      start: positionToOffset(pyTexts[rel], { line: l1 - 1, character: c1 }), end: positionToOffset(pyTexts[rel], { line: l2 - 1, character: c2 }),
    }))]));
    for (const [p, qual] of [['httpx/_models.py', 'Response.raise_for_status'], ['httpx/_models.py', 'Headers.multi_items'], ['httpx/_models.py', 'Response.read'], ['httpx/_client.py', 'Client.send']]) {
      const target = findSym(p, qual);
      const name = target.def.name;
      const prep = await services.prepare(doc(p), target.pos);
      if (!prep || prep.length === 0) { say(`- ${qual}: prepare -> ${JSON.stringify(prep)}`); continue; }
      const inc = await services.incoming(prep[0]);
      if (inc === null) { say(`- ${qual}: incomingCalls -> null`); continue; }
      const listed = new Set(inc.flatMap((c) => c.fromRanges.map((r) => `${c.uri}#${r.start}`)));
      /** @type {{ rel: string, d: Doc, off: number }[]} */
      const hits = [];
      const re = new RegExp(`\\.${name}\\(`, 'g');
      for (const rel of pyFiles) {
        const d = doc(rel);
        for (const m of d.text.matchAll(re)) hits.push({ rel, d, off: /** @type {number} */ (m.index) + 1 });
      }
      const counts = { listed: 0, inStringOrComment: 0, resolvesToTargetNotListed: 0, otherDefinition: 0, unresolved: 0, error: 0, notClassified: Math.max(0, hits.length - MAX_HITS_CLASSIFIED) };
      /** @type {Record<string, string[]>} */
      const examples = { unresolved: [], otherDefinition: [], resolvesToTargetNotListed: [] };
      const targetUri = uriOf(p);
      for (const h of hits.slice(0, MAX_HITS_CLASSIFIED)) {
        const where = `${h.rel}:${lineOf(h.d.text, h.off)}`;
        if (listed.has(`${h.d.uri}#${h.off}`)) { counts.listed++; continue; }
        if ((stringSpans.get(h.rel) || []).some((sp) => sp.start <= h.off && h.off < sp.end)) { counts.inStringOrComment++; continue; }
        const def = await timed(() => services.definition(h.d, h.off));
        if (def.error) { counts.error++; continue; }
        const locs = def.value || [];
        /** @type {'unresolved'|'resolvesToTargetNotListed'|'otherDefinition'} */
        const kind = locs.length === 0 ? 'unresolved' : locs.some((l) => l.uri === targetUri && l.start === target.pos) ? 'resolvesToTargetNotListed' : 'otherDefinition';
        counts[kind]++;
        const lineText = h.d.text.slice(h.d.text.lastIndexOf('\n', h.off) + 1, h.d.text.indexOf('\n', h.off)).trim();
        const target2 = locs[0] ? ` -> ${path.relative(repo, fileURLToPath(locs[0].uri)).replace(/^.*node_modules\//, '…/')}` : '';
        if (examples[kind].length < (kind === 'unresolved' ? 20 : 4)) examples[kind].push(`${where} \`${lineText.slice(0, 70)}\`${target2}`);
      }
      const sitesListed = [...listed].length;
      say(`- ${qual}: call hierarchy ${inc.length} caller(s), ${sitesListed} site(s); text hits \`.${name}(\`: ${hits.length}; ${JSON.stringify(counts)}`);
      for (const [k, xs] of Object.entries(examples)) if (xs.length) say(`    ${k}: ${xs.join('; ')}`);
      const listedNotText = [...listed].filter((k) => !hits.some((h) => `${h.d.uri}#${h.off}` === k)).length;
      say(`    sites listed by the server but not text hits (other call forms): ${listedNotText}`);
    }
    say('');

    // ---- 6b. warm timings -------------------------------------------------------
    say('## 6. Timings');
    say(`- spawn + initialize: ${fmt(tInit.ms)}`);
    say(`- first documentSymbol (httpx/_client.py), after initialize: ${fmt(cold.ms)}`);
    say(`- first prepareCallHierarchy / incomingCalls (Response.raise_for_status): ${fmt(coldPrep.ms)} / ${fmt(coldInc.ms)}`);
    const methods = ast['httpx/_models.py'].filter((d) => d.qual.startsWith('Response.') && !d.inFunction).slice(10, 10 + WARM_QUERIES);
    /** @type {number[]} */ const prepT = []; /** @type {number[]} */ const incT = []; /** @type {number[]} */ const refT = [];
    for (const m of methods) {
      const pos = defNameOffset(doc('httpx/_models.py').text, m.line, m.name);
      const pr = await timed(() => services.prepare(doc('httpx/_models.py'), pos));
      prepT.push(pr.ms);
      if (pr.value && pr.value.length) incT.push((await timed(() => services.incoming(/** @type {any[]} */ (pr.value)[0]))).ms);
      refT.push((await timed(() => services.references(doc('httpx/_models.py'), pos))).ms);
    }
    /** @type {number[]} */ const symT = [];
    for (const rel of pyFiles.filter((f) => f.startsWith('httpx/') && !symFiles.includes(f)).slice(0, WARM_QUERIES)) {
      const r = await timed(() => services.documentSymbols(doc(rel)));
      if (!r.error) symT.push(r.ms);
    }
    const row = (/** @type {string} */ n, /** @type {number[]} */ xs) => say(`- ${n}: n=${xs.length}, median ${fmt(median(xs))}, max ${fmt(Math.max(...xs))}`);
    row('warm prepareCallHierarchy (Response methods)', prepT);
    row('warm incomingCalls', incT);
    row('warm references', refT);
    row('documentSymbol on first open of other httpx/ files', symT);
    say('');
    for (const rel of diagFiles) {
      const diags = services.diagnostics.get(uriOf(rel));
      const unresolved = (diags || []).filter((x) => /could not be resolved/.test(x.message)).map((x) => x.message);
      say(`diagnostics published for ${rel}: ${diags ? diags.length : 'none received'}; unresolved imports: ${[...new Set(unresolved)].join(' | ') || 'none'}`);
    }
    const interesting = services.logs.filter((l) => /search path|source file|python|import|environment|Loading/i.test(l)).slice(0, 12);
    say(`pyright log lines (selected): ${interesting.map((l) => JSON.stringify(l.slice(0, 160))).join(' | ') || '(none)'}`);
    say(`(total run time ${fmt(Date.now() - startedAt)})`);
  } finally {
    clearTimeout(killTimer);
    try { fs.rmSync(scratchPath, { force: true }); } catch (e) { progress(`could not remove ${scratchPath}: ${/** @type {Error} */ (e).message}`); }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { progress(`could not remove ${tmpDir}: ${/** @type {Error} */ (e).message}`); } }
    await services.close();
  }
}

main().then(() => {
  process.stdout.write(report.join('\n') + '\n');
  process.exit(0);
}).catch((err) => {
  process.stdout.write(report.join('\n') + '\n');
  process.stderr.write(`p0-spike failed: ${err.stack || err}\n`);
  process.exit(1);
});
