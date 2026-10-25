'use strict';
/**
 * P7 (docs/MULTI_LANGUAGE_PLAN.md, Part P): the real pipeline and Python provider against
 * Pyright on a corpus of merged encode/httpx pull requests (./py-verify-corpus.json), checked
 * against two oracles that share no code with the engine (P-D3). A development script, not
 * part of `npm test`: it needs Pyright (P-D1), a virtualenv with Jedi (JEDI_PYTHON), an httpx
 * clone and a worktree of it. Results: test/lsp-harness/P7-REPORT.md. Built like G7's
 * go-verify.js.
 *
 *   node test/lsp-harness/py-verify.js <absolute path to httpx clone> --worktree <absolute path to a worktree of it>
 *     [--prs 3319,3394] [--pyright path] [--jedi-python path] [--out dir] [--summary file]
 *     [--cache dir] [--no-cache] [--deadline-ms n] [--syntactic] [--corpus file.json]
 *
 * `--corpus`: another list of PRs in py-verify-corpus.json's shape (number, head, base, …), such
 * as open PRs fetched for an out-of-sample check; default ./py-verify-corpus.json.
 *
 * `--syntactic` (A4, A8.2): the pipeline runs without a language server, as the CLI does, so
 * Python is read from its text (`prepareSyntactic`) and callers come from the syntax index
 * (A8). Changed functions and kinds are compared with oracle (a), callers with Jedi (b)
 * restricted to the files the index indexed (CLI scope: every Python file of the head the
 * provider handles, `pythonRules.handles`; the run fails if the index says it was bounded).
 * Every changed Python row must be incomplete with the syntax-only scope note, never `none`,
 * and no verdict may read "no callers" (`scopeViolations` lists any that is not). No Pyright.
 *
 * `--preview` (with `--syntactic`, A8.2): the preview's scope instead. `analyzeRemote` runs
 * offline with a fake `gh` that reads only the clone's git objects (`git diff`, `git show`,
 * as the scratchpad's a8/preview-offline.js), so the index holds the PR's changed Python
 * files and changed tests the preview fetched; Jedi's callers are restricted to those files
 * (the head-side Python paths the fake `gh` served).
 *
 * `--package <dir>` (default `httpx`): the package directory oracle (a) reads (pydantic: `pydantic`).
 *
 * Two phases, run side by side:
 * - Oracles, per PR (at most ORACLE_CONCURRENCY PRs at once). The head commit is exported with
 *   `git archive` into a temporary directory (the clone's worktree and .git are not touched,
 *   so PRs share no checkout). Then
 *   (a) changed functions: AST_PROGRAM (standard library only, `python3 -I`, written to a
 *       temporary directory and run from another, with a deadline) parses both sides of every
 *       changed non-test `httpx/` file with `ast` and lists each module function or class
 *       method (classes nested in classes too; defs inside functions are the parent's body,
 *       P-D5) whose source text (first decorator to the body's end) changed, was added or
 *       removed, keyed as the provider keys them (`Class.method`, repeats `#2` in source
 *       order), with its parameters, returns, decorators, binding and raised names (as
 *       `raisesOf` counts them); it also indexes every such function's lines in the export,
 *       to name the function enclosing a call;
 *   (b) callers: JEDI_PROGRAM, Jedi's `Script.get_references` at each changed or added
 *       function's name over the exported tree (`jedi.Project(path=<export>)`), run with the
 *       Jedi virtualenv's `python -I` the same way. For `__init__` the class name's
 *       references are asked too (a construction `Cls(...)` calls it). Each reference is
 *       returned with what follows and precedes it, and the comparison keeps calls (followed
 *       by `(`; for a property, an attribute access). Jedi reads the files with parso; it
 *       imports no source module. The program checks that afterwards (no module loaded from
 *       the export, `sys.path` unchanged) and fails otherwise; the export must contain no
 *       compiled extension (checked before Jedi runs), and `auto_import_modules` is emptied.
 * - Pipeline, per PR, one after the other (it needs the worktree): the worktree must be clean;
 *   it is checked out at the PR's head (detached), a fresh Pyright is started, and `analyze()`
 *   runs as py-e2e.js does (`pr` mode against the base commit, the Python provider's caller
 *   extras, the editor's options: skipForest, test reach deferred). At the end the worktree
 *   is put back on the branch it was on.
 * Then each PR is compared (`comparePr`) into `<out>/<n>.json`, and every PR's JSON is
 * summarised into `--summary` (Markdown, default `<out>/summary.md`).
 *
 * Cache. An oracle's answer depends only on the two commits and the tools, so it is kept in
 * `--cache` (default DEFAULT_CACHE, outside the repository) as
 * `<head sha>-<base sha>/<ast|jedi>-<tool hash>.json`. The tool hash is a SHA-256 over
 * AST_PROGRAM and `python3 --version` for (a), and over JEDI_PROGRAM, the Jedi Python's
 * version, Jedi's and parso's versions and AST_PROGRAM (the targets come from (a)) for (b).
 * A changed tool or commit is a different file; nothing is invalidated in place, and the
 * directory may be deleted at any time. `--no-cache` neither reads nor writes it.
 *
 * Budget. The whole run has a deadline (`--deadline-ms`, default RUN_DEADLINE_MS): when it
 * passes, every child process (Pyright, the oracles, git) is killed, the worktree is put
 * back on its branch, and the run exits with code 2 and says so; nothing partial is
 * summarised. Each oracle child also has its own deadline (ORACLE_CHILD_DEADLINE_MS), and
 * each Jedi query JEDI_QUERY_DEADLINE_S; a query past it fails the PR's oracle (no partial
 * oracle is compared).
 *
 * The clone and worktree are data: nothing of httpx is run. Only git, Pyright and the two
 * oracle programs read them. Wall-clock time is fine here: this is a measurement script.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { analyze } = require('../../src/engine/analyze');
const { createPyrightServices, DEFAULT_PYRIGHT } = require('./pyright-services');
const { languageServicesOver, createHierarchyResolver } = require('./harness-languages');
const { pythonProvider } = require('../../src/languages/python/provider');
const { classifyChangeVerdict, toneOf } = require('../../src/tree-row-models');
const { pythonRules } = require('../../src/languages/python/rules');

/** The corpus: squash-merged httpx PRs; `head` is the squash commit, `base` its parent. */
const CORPUS = require('./py-verify-corpus.json');

/** The whole run, in milliseconds; the plan's budget is 5 min uncached, 2 min cached. */
const RUN_DEADLINE_MS = 8 * 60 * 1000;
/** PRs whose oracles run at once (the plan: 3). */
const ORACLE_CONCURRENCY = 3;
/** One oracle child process (ast over a PR, or Jedi over a PR's targets). */
const ORACLE_CHILD_DEADLINE_MS = 4 * 60 * 1000;
/** One Jedi `get_references` query, in seconds (SIGALRM in the child). */
const JEDI_QUERY_DEADLINE_S = 60;
/** Pyright's start (spawn + initialize). */
const PYRIGHT_START_DEADLINE_MS = 60000;
const DEFAULT_CACHE = '/Users/salah/Projects/impact-tree-scratchpad/py-verify-cache';
const JEDI_PYTHON = '/Users/salah/Projects/impact-tree-scratchpad/py-tools/venv/bin/python';

/** @param {string[]} args @param {string} flag @param {string} fallback */
const option = (args, flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };

/** @param {string} repo @param {string[]} args */
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 60000 });

/** Every child process this run started and has not seen exit; killed at the deadline. */
const children = new Set();
function track(proc) {
  children.add(proc);
  proc.on('exit', () => children.delete(proc));
  return proc;
}

/** Runs a command to completion within `timeoutMs`; rejects with its stderr on failure. */
function run(cmd, args, { cwd, input, timeoutMs = ORACLE_CHILD_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = track(spawn(cmd, args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['pipe', 'pipe', 'pipe'] }));
    const out = [];
    let err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, timeoutMs);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { if (err.length < 65536) err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${path.basename(cmd)} ${args.slice(0, 2).join(' ')} exited ${code ?? signal}${signal === 'SIGKILL' ? ` (deadline ${timeoutMs} ms?)` : ''}: ${err.slice(-2000)}`));
    });
    if (input !== undefined) proc.stdin.end(input); else proc.stdin.end();
  });
}

/** A counting semaphore: `use(fn)` runs `fn` when one of `n` slots is free. */
function semaphore(n) {
  let free = n;
  const waiting = [];
  const release = () => { free++; const next = waiting.shift(); if (next) next(); };
  return async (fn) => {
    if (free === 0) await new Promise((r) => waiting.push(r));
    free--;
    try { return await fn(); } finally { release(); }
  };
}

const sha256 = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };

// Oracle (a). Standard library only. Input (stdin): {"pairs": [{"rel", "baseFile", "headFile"}],
// "indexRoot": dir}. Output: {"changes", "index", "errors"}.
const AST_PROGRAM = String.raw`
import ast, io, json, os, re, sys, tokenize

SKIP_DIRS = {"venv", ".venv", "site-packages", "__pycache__", ".tox", "node_modules", ".git"}
NAME = re.compile(r"[^\W\d]\w*(?:\.[^\W\d]\w*)*")
BLOCKS = tuple(t for t in (ast.If, ast.Try, getattr(ast, "TryStar", None), ast.With, ast.AsyncWith, ast.For, ast.AsyncFor, ast.While) if t)

def split_lines(src):
    return src.encode("utf-8").splitlines(keepends=True)

def seg(lines, l1, c1, l2, c2):
    # ast offsets: 1-based lines, UTF-8 byte columns
    if l1 == l2:
        return lines[l1 - 1][c1:c2].decode("utf-8")
    return b"".join([lines[l1 - 1][c1:]] + lines[l1:l2 - 1] + [lines[l2 - 1][:c2]]).decode("utf-8")

def node_text(lines, n):
    return seg(lines, n.lineno, n.col_offset, n.end_lineno, n.end_col_offset)

def no_comments(text):
    toks = tokenize.generate_tokens(io.StringIO(text.strip()).readline)
    return "".join(t.string + " " for t in toks if t.type not in (tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT)).strip()

def decl_start(lines, fn):
    if not fn.decorator_list:
        return fn.lineno, fn.col_offset
    d = fn.decorator_list[0]
    ln, col = d.lineno, d.col_offset
    while True:
        at = lines[ln - 1][:col].rfind(b"@")
        if at >= 0:
            return ln, at
        ln -= 1
        col = len(lines[ln - 1])

def raises_in(lines, nodes):
    out = set()
    stack = list(nodes)
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(n, ast.Raise) and n.exc is not None:
            m = NAME.match(node_text(lines, n.exc).lstrip("( \t\r\n"))
            if m:
                out.add(m.group(0))
        stack.extend(ast.iter_child_nodes(n))
    return sorted(out)

def params_of(lines, a):
    out = []
    ann = lambda x: None if x.annotation is None else no_comments(node_text(lines, x.annotation))
    pos = list(a.posonlyargs) + list(a.args)
    ndef = len(a.defaults)
    for i, x in enumerate(pos):
        out.append({"name": x.arg, "kind": "posonly" if i < len(a.posonlyargs) else "arg", "ann": ann(x), "optional": i >= len(pos) - ndef})
    if a.vararg:
        out.append({"name": a.vararg.arg, "kind": "vararg", "ann": ann(a.vararg), "optional": False})
    for x, d in zip(a.kwonlyargs, a.kw_defaults):
        out.append({"name": x.arg, "kind": "kwonly", "ann": ann(x), "optional": d is not None})
    if a.kwarg:
        out.append({"name": a.kwarg.arg, "kind": "kwarg", "ann": ann(a.kwarg), "optional": False})
    return out

def binding_of(decorators):
    b = "function"
    for d in decorators:
        n = re.sub(r"\s+", "", d)
        if n == "staticmethod": b = "staticmethod"
        elif n == "classmethod": b = "classmethod"
        elif n in ("property", "functools.cached_property", "cached_property") or re.search(r"\.(setter|getter|deleter)$", n): b = "property"
    return b

def name_col(text_line, name):
    m = re.search(r"\bdef\s+(" + re.escape(name) + r")\b", text_line)
    return m.start(1) if m else None

def candidates(tree, lines, full):
    # Module functions and class methods (classes nested in classes too), through if/try/with/
    # for/while blocks, never into a function (P-D5). Keys as the provider's: qualified name,
    # repeats "#n" in source order.
    found = []
    def scope(stmts, prefix, cls):
        for st in stmts:
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                found.append((st, prefix + st.name, cls))
            elif isinstance(st, ast.ClassDef):
                scope(st.body, prefix + st.name + ".", st)
            elif isinstance(st, BLOCKS):
                for field in ("body", "orelse", "finalbody"):
                    scope(getattr(st, field, None) or [], prefix, cls)
                for h in getattr(st, "handlers", None) or []:
                    scope(h.body, prefix, cls)
    scope(tree.body, "", None)
    found.sort(key=lambda f: (decl_start(lines, f[0]), f[0].lineno))
    seen = {}
    out = []
    for fn, q, cls in found:
        seen[q] = seen.get(q, 0) + 1
        key = q if seen[q] == 1 else q + "#" + str(seen[q])
        l1, c1 = decl_start(lines, fn)
        def_line = lines[fn.lineno - 1].decode("utf-8")
        x = {"key": key, "name": fn.name, "nameLine": fn.lineno, "nameCol": name_col(def_line, fn.name), "startLine": l1, "endLine": fn.end_lineno}
        if full:
            decorators = [no_comments(node_text(lines, d)) for d in fn.decorator_list]
            x.update({
                "text": seg(lines, l1, c1, fn.end_lineno, fn.end_col_offset),
                "isMethod": cls is not None,
                "className": cls.name if cls is not None else None,
                "classLine": cls.lineno if cls is not None else None,
                "classCol": (lambda m: m.start(1) if m else None)(re.search(r"\bclass\s+(" + re.escape(cls.name) + r")\b", lines[cls.lineno - 1].decode("utf-8"))) if cls is not None else None,
                "async": isinstance(fn, ast.AsyncFunctionDef),
                "decorators": decorators,
                "binding": binding_of(decorators),
                "params": params_of(lines, fn.args),
                "returns": None if fn.returns is None else no_comments(node_text(lines, fn.returns)),
                "raises": raises_in(lines, fn.body),
            })
        out.append(x)
    return out

def parse(path):
    with open(path, "rb") as fh:
        src = fh.read().decode("utf-8")
    return ast.parse(src), split_lines(src)

def main():
    job = json.load(sys.stdin)
    out = {"changes": [], "index": {}, "errors": []}
    for p in job["pairs"]:
        sides = []
        try:
            for f in (p["baseFile"], p["headFile"]):
                if not f:
                    sides.append([])
                    continue
                tree, lines = parse(f)
                sides.append(candidates(tree, lines, True))
        except Exception as e:
            out["errors"].append(p["rel"] + ": " + repr(e))
            continue
        base = {b["key"]: b for b in sides[0]}
        head_keys = set()
        for h in sides[1]:
            head_keys.add(h["key"])
            b = base.get(h["key"])
            if b is None:
                out["changes"].append({"rel": p["rel"], "key": h["key"], "status": "added", "base": None, "head": h})
            elif b["text"] != h["text"]:
                out["changes"].append({"rel": p["rel"], "key": h["key"], "status": "changed", "base": b, "head": h})
        for b in sides[0]:
            if b["key"] not in head_keys:
                out["changes"].append({"rel": p["rel"], "key": b["key"], "status": "removed", "base": b, "head": None})
    root = job["indexRoot"]
    for dp, dns, fns in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        dns[:] = sorted(d for d in dns if d not in SKIP_DIRS)
        for f in sorted(fns):
            if not f.endswith(".py"):
                continue
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            try:
                tree, lines = parse(p)
            except Exception as e:
                out["errors"].append("index " + rel + ": " + repr(e))
                continue
            out["index"][rel] = [{"key": c["key"], "nameLine": c["nameLine"], "startLine": c["startLine"], "endLine": c["endLine"]} for c in candidates(tree, lines, False)]
    json.dump(out, sys.stdout)

main()
`;

// Oracle (b). Input (stdin): {"root": export dir, "cacheDir": dir, "deadline": s, "targets":
// [{"id", "rel", "line", "col", "name"}]} (1-based line, 0-based column). Output: {"jedi",
// "parso", "results": [{"id", "refs": [{"rel", "line", "col", "after", "before"}]}], "check"}.
const JEDI_PROGRAM = String.raw`
import json, os, signal, sys
before_path = list(sys.path)
import jedi, parso
job = json.load(sys.stdin)
root = os.path.realpath(job["root"])
jedi.settings.auto_import_modules = []
jedi.settings.cache_directory = job["cacheDir"]
env = jedi.InterpreterEnvironment()
project = jedi.Project(path=root, load_unsafe_extensions=False)

class Deadline(Exception):
    pass

def on_alarm(signum, frame):
    raise Deadline()

signal.signal(signal.SIGALRM, on_alarm)
lines_of = {}
def line_text(path, line):
    if path not in lines_of:
        with open(path, encoding="utf-8") as fh:
            lines_of[path] = fh.read().split("\n")
    ls = lines_of[path]
    return ls[line - 1] if 0 < line <= len(ls) else ""

results = []
for t in job["targets"]:
    path = os.path.join(root, t["rel"])
    signal.alarm(job["deadline"])
    try:
        script = jedi.Script(path=path, project=project, environment=env)
        refs = script.get_references(t["line"], t["col"], include_builtins=False)
    except Deadline:
        sys.stderr.write("Jedi query past its deadline: %s %s:%d\n" % (t["id"], t["rel"], t["line"]))
        sys.exit(3)
    finally:
        signal.alarm(0)
    out = []
    for r in refs:
        if r.module_path is None:
            continue
        mp = os.path.realpath(str(r.module_path))
        rel = os.path.relpath(mp, root)
        if rel.startswith(".."):
            continue
        if r.is_definition():
            continue
        text = line_text(mp, r.line)
        out.append({"rel": rel.replace(os.sep, "/"), "line": r.line, "col": r.column,
                    "after": text[r.column + len(t["name"]):].lstrip()[:1], "before": text[:r.column].rstrip()[-1:],
                    "lineText": text.strip()[:160]})
    results.append({"id": t["id"], "refs": out})

loaded = sorted(n for n, m in list(sys.modules.items())
                if getattr(m, "__file__", None) and os.path.realpath(m.__file__).startswith(root + os.sep))
json.dump({"jedi": jedi.__version__, "parso": parso.__version__, "results": results,
           "check": {"modulesFromExport": loaded, "sysPathUnchanged": sys.path == before_path,
                     "exportOnSysPath": any(os.path.realpath(p or ".").startswith(root) for p in sys.path)}}, sys.stdout)
`;

/** Writes `program` into a fresh temporary directory and runs it with `python -I` from another. */
async function runPython(python, program, input) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-p7-script-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'it-p7-cwd-'));
  try {
    const script = path.join(scriptDir, 'oracle.py');
    fs.writeFileSync(script, program);
    return JSON.parse(await run(python, ['-I', script], { cwd, input: JSON.stringify(input) }));
  } finally {
    fs.rmSync(scriptDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// The file rules, written again from the plan's P1 rather than taken from rules.js, so a
// disagreement shows: in the package, not a test file.
let packageDir = 'httpx';
const isPackageSource = (rel) => rel.startsWith(`${packageDir}/`) && rel.endsWith('.py') && !/(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(rel) && !/(^|\/)tests?\//.test(rel);

/** The changed package files between `base` and `head` (renames followed), as pairs; sides written under `work`. */
function changedPairs(repo, base, head, work) {
  const rows = git(repo, 'diff', '--name-status', '-M', base, head, '--', '*.py').trim().split('\n').filter(Boolean);
  const pairs = [];
  for (const row of rows) {
    const parts = row.split('\t');
    const status = parts[0][0];
    const oldRel = parts[1];
    const rel = parts[parts.length - 1];
    if (!isPackageSource(rel) && !(status === 'D' && isPackageSource(oldRel))) continue;
    const pair = { rel, baseFile: '', headFile: '' };
    for (const [side, sha, p] of [['base', base, oldRel], ['head', head, rel]]) {
      if ((side === 'base' && status === 'A') || (side === 'head' && status === 'D')) continue;
      const f = path.join(work, side, p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, execFileSync('git', ['-C', repo, 'show', `${sha}:${p}`], { maxBuffer: 1 << 28, timeout: 60000 }));
      pair[side === 'base' ? 'baseFile' : 'headFile'] = f;
    }
    pairs.push(pair);
  }
  return pairs;
}

/** Head-side changed line numbers per repository-relative path, from `git diff -U0`. */
function headChangedLines(repo, base, head) {
  const text = git(repo, 'diff', '-U0', '-M', '--no-color', base, head, '--', '*.py');
  /** @type {Record<string, number[]>} */
  const out = {};
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(6); if (file && !out[file]) out[file] = []; continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let l = start; l < start + count; l++) out[file].push(l);
    }
  }
  return out;
}

/** Reads `name` (JSON) from the cache, or computes and writes it. `cacheDir` null: no cache. */
async function cached(cacheDir, name, compute) {
  if (!cacheDir) return { value: await compute(), hit: false };
  const file = path.join(cacheDir, name);
  if (fs.existsSync(file)) return { value: JSON.parse(fs.readFileSync(file, 'utf8')), hit: true };
  const value = await compute();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
  return { value, hit: false };
}

/** Jedi's targets for one PR: each changed or added function's name; for `__init__` its class's name too. */
function jediTargets(oracle) {
  const targets = [];
  for (const o of oracle.changes) {
    if (o.status === 'removed') continue;
    const h = o.head;
    if (h.nameCol === null) throw new Error(`${o.rel}#${o.key}: no def name column`);
    const id = `${o.rel}#${o.key}`;
    targets.push({ id, rel: o.rel, line: h.nameLine, col: h.nameCol, name: h.name });
    if (h.name === '__init__' && h.className && h.classCol !== null) {
      targets.push({ id: `${id}|class`, rel: o.rel, line: h.classLine, col: h.classCol, name: h.className });
    }
  }
  return targets;
}

/** Both oracles for one PR, from the cache when it has them. The head is exported only when needed. */
async function oraclesFor({ repo, pr, hashes, cacheRoot, jediPython, log }) {
  const started = Date.now();
  const cacheDir = cacheRoot ? path.join(cacheRoot, `${pr.head}-${pr.base}`) : null;
  let exportRoot = null;
  let exported = null;
  const ensureExport = () => (exported ??= (async () => {
    exportRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `it-p7-${pr.number}-tree-`)));
    await run('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, pr.head, exportRoot], { timeoutMs: 60000 });
    const compiled = git(repo, 'ls-tree', '-r', '--name-only', pr.head).split('\n').filter((f) => /\.(so|pyd|dylib)$/.test(f));
    if (compiled.length) throw new Error(`#${pr.number}: the export has compiled extensions Jedi could import: ${compiled.join(', ')}`);
    return exportRoot;
  })());
  try {
    const astResult = await cached(cacheDir, `ast-${hashes.ast}.json`, async () => {
      const root = await ensureExport();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `it-p7-${pr.number}-sides-`));
      try {
        const pairs = changedPairs(repo, pr.base, pr.head, work);
        const out = await runPython('python3', AST_PROGRAM, { pairs, indexRoot: root });
        return { ...out, changedLines: headChangedLines(repo, pr.base, pr.head) };
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
    const oracle = astResult.value;
    if (oracle.errors.length) throw new Error(`#${pr.number}: ast could not read ${oracle.errors.join('; ')}`);
    const targets = jediTargets(oracle);
    const jediResult = await cached(cacheDir, `jedi-${hashes.jedi}.json`, async () => {
      const root = await ensureExport();
      const jediCache = fs.mkdtempSync(path.join(os.tmpdir(), `it-p7-${pr.number}-jedi-cache-`));
      try {
        const out = await runPython(jediPython, JEDI_PROGRAM, { root, cacheDir: jediCache, deadline: JEDI_QUERY_DEADLINE_S, targets });
        const c = out.check;
        if (c.modulesFromExport.length || !c.sysPathUnchanged || c.exportOnSysPath) {
          throw new Error(`#${pr.number}: Jedi loaded code from the export or changed sys.path: ${JSON.stringify(c)}`);
        }
        return out;
      } finally {
        fs.rmSync(jediCache, { recursive: true, force: true });
      }
    });
    const jedi = jediResult.value;
    if (jedi.results.length !== targets.length) throw new Error(`#${pr.number}: Jedi answered ${jedi.results.length} of ${targets.length} targets`);
    const hits = [astResult.hit, jediResult.hit].filter(Boolean).length;
    const refs = jedi.results.reduce((s, r) => s + r.refs.length, 0);
    log(`#${pr.number} oracles: ${oracle.changes.length} function changes, Jedi ${targets.length} targets, ${refs} references (${hits}/2 cached, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return { oracle, jedi, oracleMs: Date.now() - started, cachedOracles: hits };
  } finally {
    if (exported) await exported.catch(() => {});
    if (exportRoot) fs.rmSync(exportRoot, { recursive: true, force: true });
  }
}

/** UTF-16 offset → 1-based line, per file, from the text on disk. */
function lineFinder() {
  const cache = new Map();
  return (file, offset) => {
    let starts = cache.get(file);
    if (!starts) {
      const text = fs.readFileSync(file, 'utf8');
      starts = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
      cache.set(file, starts);
    }
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/** The pipeline on one PR, fresh Pyright, the worktree checked out at the PR's head. */
async function pipelineFor(worktree, pr, pyrightPath, syntactic = false, preview = false) {
  if (git(worktree, 'status', '--porcelain', '--untracked-files=no').trim()) throw new Error('the worktree has uncommitted changes');
  git(worktree, 'checkout', '-q', '--detach', pr.head);
  if (git(worktree, 'rev-parse', 'HEAD').trim() !== pr.head) throw new Error(`the worktree is not at ${pr.head}`);
  const t0 = Date.now();
  if (syntactic && preview) {
    // The preview, offline: a fake `gh` over the git objects (no checkout is read). The
    // worktree is at the head only so that call-site offsets turn into lines from disk.
    const served = new Set();
    const statusOf = { A: 'added', D: 'removed', M: 'modified' };
    const gh = {
      listPullRequestFiles: async () => {
        const files = git(worktree, 'diff', '--name-status', '--no-renames', pr.base, pr.head).trim().split('\n').filter(Boolean).map((l) => {
          const [s, p] = l.split('\t');
          const diff = git(worktree, 'diff', '--no-renames', pr.base, pr.head, '--', p);
          const at = diff.indexOf('\n@@');
          return { path: p, oldPath: p, status: statusOf[s[0]] || 'modified', patch: at >= 0 ? diff.slice(at + 1) : null };
        });
        return { total: files.length, files };
      },
      fileAtRef: async (/** @type {any} */ _slug, /** @type {string} */ p, /** @type {string} */ ref) => {
        try { const t = git(worktree, 'show', `${ref}:${p}`); if (ref === pr.head) served.add(p); return t; } catch { return null; }
      },
    };
    let firstMs = null;
    const { analyzeRemote } = require('../../src/engine/analyze-remote');
    const result = await analyzeRemote({
      ts: require('typescript'), gh, slug: {}, repoRoot: worktree,
      pr: { number: pr.number, headSha: pr.head, mergeBaseSha: pr.base, baseRef: 'base' },
      onPrepared: () => { firstMs = Date.now() - t0; },
    });
    return { result, startMs: 0, firstMs, fullMs: Date.now() - t0, indexed: new Set([...served].filter((p) => pythonRules.handles(p))) };
  }
  if (syntactic) {
    let firstMs = null;
    const result = await analyze(worktree, {
      mode: 'pr', base: pr.base, allowLocalBase: true, skipForest: true, deferTestReach: true, depth: 2,
      onPrepared: () => { firstMs = Date.now() - t0; },
    });
    // A8-D1 (b): the CLI indexes every Python file it handles (tracked or not; Jedi's export
    // has the tracked ones), unless bounded, which this check refuses.
    const listed = git(worktree, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter((p) => p && pythonRules.handles(p));
    const note = (result.warnings || []).find((w) => /Python callers from syntax only/.test(w)) || '';
    if (!note.includes(`the repository (${listed.length} Python file(s) indexed)`)) throw new Error(`#${pr.number}: the CLI's index is not the whole repository (${listed.length} files): ${note}`);
    return { result, startMs: 0, firstMs, fullMs: Date.now() - t0, indexed: new Set(listed) };
  }
  const pyright = createPyrightServices({ repo: worktree, pyrightPath });
  track(pyright.client.proc);
  try {
    await pyright.start({ deadlineMs: PYRIGHT_START_DEADLINE_MS });
    const startMs = Date.now() - t0;
    const services = languageServicesOver(/** @type {any} */ (pyright), { repoRoot: worktree });
    let firstMs = null;
    const result = await analyze(worktree, {
      mode: 'pr', base: pr.base, allowLocalBase: true, skipForest: true, deferTestReach: true, depth: 2,
      languageServices: services,
      onPrepared: () => { firstMs = Date.now() - t0; },
      makeResolver: ({ language }) => {
        const extras = language === 'python' && pythonProvider.editorCallers
          ? pythonProvider.editorCallers({ ts: null, services, repoRoot: worktree, trace: () => {}, filterInherited: false, onWarmupRetry: () => {} })
          : null;
        return createHierarchyResolver(services, { extras });
      },
    });
    return { result, startMs, firstMs, fullMs: Date.now() - t0 };
  } finally {
    await pyright.close().catch((e) => console.error(`closing Pyright: ${e.message}`));
  }
}

const squash = (t) => String(t ?? '').replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');

/** Parameters as callers see them: `self`/`cls` dropped for a method that is not static. */
function callerParams(f) {
  let ps = f.params;
  if (f.isMethod && f.binding !== 'staticmethod' && ps.length && ps[0].kind !== 'vararg' && ps[0].kind !== 'kwarg') ps = ps.slice(1);
  return ps.map((p) => ({ name: p.name, kind: p.kind, ann: squash(p.ann), optional: p.optional }));
}

/**
 * What a change must and may report, from `ast`'s view of both sides (no engine code).
 * `required`: kinds that must be present (`a|b` is either); `allowed`: kinds that may be.
 * Parameters: names count in Python (keyword calls), so a renamed parameter is a change.
 */
function expectedKinds(base, head) {
  const required = new Set();
  const allowed = new Set();
  const bp = callerParams(base), hp = callerParams(head);
  const paramsChanged = JSON.stringify(bp) !== JSON.stringify(hp);
  const asyncChanged = base.async !== head.async;
  const bindingChanged = base.binding !== head.binding;
  const returnsChanged = squash(base.returns) !== squash(head.returns);
  const newRaises = head.raises.filter((r) => !base.raises.includes(r));
  const paramKinds = ['type-changed', 'required-param', 'optional-param', 'optional-param-changed', 'param-removed'];
  if (asyncChanged) { required.add('async-changed'); allowed.add('async-changed'); }
  if (bindingChanged) { required.add('type-changed'); allowed.add('type-changed'); }
  if (paramsChanged) {
    paramKinds.forEach((k) => allowed.add(k));
    if (hp.length > bp.length) required.add('optional-param|required-param');
    else if (hp.length < bp.length) required.add('param-removed');
    else required.add(paramKinds.join('|'));
  }
  if (returnsChanged) { required.add('return-changed'); allowed.add('return-changed'); }
  if (newRaises.length) { required.add('new-throw'); allowed.add('new-throw'); }
  const headerChanged = asyncChanged || bindingChanged || paramsChanged || returnsChanged;
  if (!required.size) allowed.add('body');
  return { required: [...required], allowed: [...allowed], headerChanged, newRaises, asyncChanged, bindingChanged, paramsChanged, returnsChanged };
}

function kindsAgree(kinds, expected) {
  const missing = expected.required.filter((r) => !r.split('|').some((k) => kinds.includes(k)));
  const extra = kinds.filter((k) => !expected.allowed.includes(k));
  return { ok: !missing.length && !extra.length, missing, extra };
}

const headerText = (f) => `${f.async ? 'async ' : ''}def ${f.name}(${f.params.map((p) => `${p.kind === 'vararg' ? '*' : p.kind === 'kwarg' ? '**' : ''}${p.name}${p.ann ? `: ${p.ann}` : ''}${p.optional ? '=…' : ''}`).join(', ')})${f.returns ? ` -> ${f.returns}` : ''} [${f.binding}]`;

/**
 * Compares one PR's pipeline result with the oracles. Caller identity on every side is the
 * function that encloses the call site in the head commit (`<rel>#<key>`, `<rel>#(module)`
 * outside every function), from the `ast` index, so a nested def counts as its parent (P-D5).
 */
function comparePr({ worktree, pr, result, oracle, jedi, syntactic = false, indexed = null, preview = false }) {
  const changedLines = oracle.changedLines;
  const index = oracle.index;
  const lineOf = lineFinder();
  const rel = (abs) => path.relative(worktree, abs).split(path.sep).join('/');
  const enclosing = (relPath, line) => {
    const spans = index[relPath];
    if (!spans) return `${relPath}#(not indexed)`;
    const s = spans.find((x) => x.startLine <= line && line <= x.endLine);
    return `${relPath}#${s ? s.key : '(module)'}`;
  };
  const isTestRel = (r) => !isPackageSource(r) && /(^|\/)(tests?\/|test_[^/]*\.py$|conftest\.py$)/.test(r);

  // (a) changed functions, in the oracle's scope (non-test httpx/ files); rows outside it are counted.
  const inScope = (x) => isPackageSource(x.relPath);
  const pipelineRows = [
    ...result.allChanged.filter(inScope).map((c) => ({ id: `${c.relPath}#${c.key}|${c.added ? 'added' : 'changed'}` })),
    ...result.deleted.filter(inScope).map((d) => ({ id: `${d.relPath}#${d.key}|removed` })),
  ];
  const outOfScope = [...result.allChanged, ...result.deleted].filter((x) => !inScope(x)).map((x) => `${x.relPath}#${x.key}`);
  const oracleRows = oracle.changes.map((o) => ({ id: `${o.rel}#${o.key}|${o.status}` }));
  const pipelineIds = new Set(pipelineRows.map((r) => r.id));
  const oracleIds = new Set(oracleRows.map((r) => r.id));
  const fp = pipelineRows.filter((r) => !oracleIds.has(r.id)).map((r) => r.id);
  const fn = oracleRows.filter((r) => !pipelineIds.has(r.id)).map((r) => r.id);
  const tp = pipelineRows.filter((r) => oracleIds.has(r.id)).length;

  // Kinds, for every change both see.
  const changeById = new Map(result.allChanged.map((c) => [`${c.relPath}#${c.key}`, c]));
  const kindRows = [];
  for (const o of oracle.changes.filter((x) => x.status === 'changed')) {
    const c = changeById.get(`${o.rel}#${o.key}`);
    if (!c || c.added) continue;
    const kinds = c.kinds.map((k) => k.id);
    const expected = expectedKinds(o.base, o.head);
    kindRows.push({ id: `${o.rel}#${o.key}`, headerChanged: expected.headerChanged, newRaises: expected.newRaises, kinds, ...kindsAgree(kinds, expected), expected, baseHeader: headerText(o.base), headHeader: headerText(o.head) });
  }

  // (b) callers vs Jedi, per changed or added function both see.
  const jediById = new Map(jedi.results.map((r) => [r.id, r.refs]));
  const callerRows = [];
  for (const o of oracle.changes.filter((x) => x.status !== 'removed')) {
    const id = `${o.rel}#${o.key}`;
    const c = changeById.get(id);
    if (!c || (c.added ? 'added' : 'changed') !== o.status) continue;
    const ours = new Map();
    for (const x of c.callers || []) {
      const sites = (x.callSites || []).filter((s) => Number.isInteger(s.start));
      const lines = sites.map((s) => lineOf(x.file, s.start));
      const at = lines.length ? lines[0] : lineOf(x.file, x.pos);
      const r = rel(x.file);
      const callerId = r.startsWith('..') ? `external:${x.label}` : enclosing(r, at);
      const prev = ours.get(callerId);
      if (prev) prev.lines.push(...lines);
      else ours.set(callerId, { lines, label: x.label, test: !!x.test });
    }
    // Jedi's calls: a reference followed by `(`; for a property, an attribute access; for
    // `__init__`, also its class's name followed by `(` (a construction).
    const property = o.head.binding === 'property';
    const isCall = (r) => r.after === '(' || (property && r.before === '.');
    // Syntax only (A8.2): Jedi's callers in the files the index read; the others are out of scope.
    const inIndex = (r) => !indexed || indexed.has(r.rel);
    const allRefs = (jediById.get(id) || []).filter(isCall)
      .concat((jediById.get(`${id}|class`) || []).filter((r) => r.after === '('));
    const refs = allRefs.filter(inIndex);
    const nonCalls = (jediById.get(id) || []).filter((r) => !isCall(r));
    const jd = new Map();
    for (const r of refs) {
      const k = enclosing(r.rel, r.line);
      if (!jd.has(k)) jd.set(k, []);
      jd.get(k).push({ rel: r.rel, line: r.line, text: r.lineText });
    }
    const ourIds = [...ours.keys()];
    const jediIds = [...jd.keys()];
    const codeAt = (file, line) => { try { return fs.readFileSync(path.join(worktree, file), 'utf8').split('\n')[line - 1].trim().slice(0, 160); } catch { return ''; } };
    const falsePositives = ourIds.filter((k) => !jd.has(k)).map((k) => {
      const file = k.slice(0, k.indexOf('#'));
      return { caller: k, lines: ours.get(k).lines, file, code: ours.get(k).lines.map((l) => codeAt(file, l)) };
    });
    const missed = jediIds.filter((k) => !ours.has(k)).map((k) => ({ caller: k, sites: jd.get(k) }));
    // A Jedi caller outside the tests whose call line the PR did not touch.
    const notUpdated = jediIds.filter((k) => !isTestRel(k.slice(0, k.indexOf('#')))).filter((k) => {
      const touched = new Set(changedLines[k.slice(0, k.indexOf('#'))] || []);
      return jd.get(k).some((s) => !touched.has(s.line));
    });
    const verdict = classifyChangeVerdict(c);
    const fine = toneOf(verdict) === null;
    const risky = c.kinds.some((k) => k.id !== 'body');
    callerRows.push({
      id, status: o.status, binding: o.head.binding, kinds: c.kinds.map((k) => k.id), callerState: c.callerState,
      complete: c.callersComplete, incompleteReason: c.callersIncompleteReason,
      verdict: verdict.text, level: verdict.level, fine,
      ours: ourIds.length, jedi: jediIds.length, truePositives: ourIds.filter((k) => jd.has(k)).length,
      falsePositives, missed, jediNonCalls: nonCalls.length, jediOutsideIndex: allRefs.length - refs.length,
      noCallersSentence: NO_CALLERS.test(`${verdict.sentence || ''} ${verdict.text || ''}`),
      missedWhileComplete: missed.length > 0 && c.callersComplete !== false,
      notUpdated, fineWithNotUpdated: risky && fine && notUpdated.length > 0,
    });
  }
  return {
    functions: { tp, fp, fn, pipeline: pipelineRows.length, oracle: oracleRows.length, outOfScope },
    kinds: kindRows,
    callers: callerRows,
    // Syntax only (A8): every Python row incomplete with its scope's note, never 'none', never
    // a verdict reading "no callers".
    ...(syntactic ? { scope: preview ? 'preview' : 'cli', indexedFiles: indexed.size, scopeViolations: result.allChanged.filter((c) => /\.pyi?$/.test(c.relPath)).filter((c) => {
      const scope = preview ? "Python callers from syntax only: the pull request's own files (" : 'Python callers from syntax only: the repository (';
      const v = classifyChangeVerdict(c);
      return c.callersComplete !== false || c.callerState === 'none' || !String(c.callersIncompleteReason || '').startsWith(scope) || NO_CALLERS.test(`${v.sentence || ''} ${v.text || ''}`);
    }).map((c) => `${c.relPath}#${c.key} (${c.callerState}, complete ${c.callersComplete}: ${String(c.callersIncompleteReason).slice(0, 80)})`) } : {}),
    warnings: result.warnings,
    unanalysable: result.unanalysable,
    notAnalysed: (result.otherFiles || []).filter((f) => f.notAnalysed).map((f) => `${f.path}: ${JSON.stringify(f.notAnalysed)}`),
  };
}

/** A verdict that reads as "nobody calls it" (tree-row-models' complete-and-empty wording). */
const NO_CALLERS = /no callers|nothing calls it/i;

const pct = (a, b) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`);

/** Markdown tables from every `<out>/<n>.json` of the corpus. Fails on a missing PR. */
function summarise(out, corpus) {
  const records = corpus.map((p) => {
    const f = path.join(out, `${p.number}.json`);
    if (!fs.existsSync(f)) throw new Error(`no result for #${p.number} in ${out}: nothing summarised`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  });
  const lines = [];
  const T = { tp: 0, fp: 0, fn: 0, body: 0, bodyOk: 0, header: 0, headerOk: 0, raise: 0, raiseOk: 0, ours: 0, jedi: 0, ctp: 0, cfp: 0, cfn: 0, missChanges: 0, missWhileComplete: 0, fineNotUpdated: 0 };
  lines.push('| PR | Python files (httpx/) | functions (oracle) | precision | recall | header changes right | new raises right | body-only right | callers ours / Jedi | caller precision | caller recall | Jedi-missed on incomplete | fine with non-updated Jedi caller | oracles (s) | Pyright start / first / full |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of records) {
    const f = r.functions;
    const hdr = r.kinds.filter((k) => k.headerChanged);
    const raise = r.kinds.filter((k) => !k.headerChanged && k.newRaises.length);
    const body = r.kinds.filter((k) => !k.headerChanged && !k.newRaises.length);
    const sum = (fnc) => r.callers.reduce((s, c) => s + fnc(c), 0);
    const ours = sum((c) => c.ours), jd = sum((c) => c.jedi), ctp = sum((c) => c.truePositives);
    const cfp = sum((c) => c.falsePositives.length), cfn = sum((c) => c.missed.length);
    const missChanges = r.callers.filter((c) => c.missed.length).length;
    const missWhileComplete = r.callers.filter((c) => c.missedWhileComplete).length;
    const fineNotUpdated = r.callers.filter((c) => c.fineWithNotUpdated).length;
    Object.assign(T, {
      tp: T.tp + f.tp, fp: T.fp + f.fp.length, fn: T.fn + f.fn.length,
      header: T.header + hdr.length, headerOk: T.headerOk + hdr.filter((k) => k.ok).length,
      raise: T.raise + raise.length, raiseOk: T.raiseOk + raise.filter((k) => k.ok).length,
      body: T.body + body.length, bodyOk: T.bodyOk + body.filter((k) => k.ok).length,
      ours: T.ours + ours, jedi: T.jedi + jd, ctp: T.ctp + ctp, cfp: T.cfp + cfp, cfn: T.cfn + cfn,
      missChanges: T.missChanges + missChanges, missWhileComplete: T.missWhileComplete + missWhileComplete, fineNotUpdated: T.fineNotUpdated + fineNotUpdated,
    });
    const t = r.timing;
    const s = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}` : '–');
    lines.push(`| #${r.number} | ${r.pyFiles} (${r.packageFiles}) | ${f.oracle} | ${pct(f.tp, f.pipeline)} | ${pct(f.tp, f.oracle)} | ${hdr.filter((k) => k.ok).length}/${hdr.length} | ${raise.filter((k) => k.ok).length}/${raise.length} | ${body.filter((k) => k.ok).length}/${body.length} | ${ours} / ${jd} | ${pct(ctp, ours)} | ${pct(ctp, jd)} | ${missChanges - missWhileComplete}/${missChanges} | ${fineNotUpdated} | ${s(t.oracleMs)}${t.cachedOracles === 2 ? ' (cached)' : ''} | ${s(t.pyrightStartMs)} / ${s(t.firstMs)} / ${s(t.fullMs)} s |`);
  }
  lines.push(`| **total** | | ${T.tp + T.fn} | ${pct(T.tp, T.tp + T.fp)} | ${pct(T.tp, T.tp + T.fn)} | ${T.headerOk}/${T.header} | ${T.raiseOk}/${T.raise} | ${T.bodyOk}/${T.body} | ${T.ours} / ${T.jedi} | ${pct(T.ctp, T.ours)} | ${pct(T.ctp, T.jedi)} | ${T.missChanges - T.missWhileComplete}/${T.missChanges} | ${T.fineNotUpdated} | | |`);
  lines.push('');
  const reasons = new Map();
  let changes = 0;
  for (const r of records) for (const c of r.callers) {
    changes++;
    if (c.complete === false) reasons.set(c.incompleteReason, (reasons.get(c.incompleteReason) || 0) + 1);
  }
  lines.push(`Changed or added functions with callers compared: ${changes}; incomplete answers by reason: ${[...reasons].map(([k, v]) => `${k} ${v}`).join('; ') || 'none'}.`);
  lines.push('');
  if (records[0] && records[0].scope) {
    const count = (fnc) => records.reduce((s, r) => s + fnc(r), 0);
    const complete = count((r) => r.callers.filter((c) => c.complete !== false).length);
    const noneRows = count((r) => r.callers.filter((c) => c.callerState === 'none' || c.noCallersSentence).length);
    const violations = count((r) => r.scopeViolations.length);
    const outside = count((r) => r.callers.reduce((n, c) => n + c.jediOutsideIndex, 0));
    lines.push(`TOTAL (${records[0].scope} scope): caller precision ${pct(T.ctp, T.ours)} (${T.ctp}/${T.ours}), recall ${pct(T.ctp, T.jedi)} (${T.ctp}/${T.jedi}); Jedi misses on incomplete answers ${T.missChanges - T.missWhileComplete}/${T.missChanges} changes; complete answers ${complete}; none / "no callers" rows ${noneRows}; scope violations ${violations}; Jedi call references outside the indexed files (not compared) ${outside}; functions ${T.tp}/${T.tp + T.fn} (${T.fp} extra); kinds ${T.headerOk + T.raiseOk + T.bodyOk}/${T.header + T.raise + T.body}.`);
    lines.push('');
  }
  lines.push(`Caller false positives against Jedi: ${T.cfp}. Jedi callers we miss: ${T.cfn}, on ${T.missChanges} changes, ${T.missWhileComplete} of them complete.`);
  lines.push('');
  for (const r of records) {
    lines.push(`### #${r.number}`);
    lines.push('');
    if (r.functions.fp.length) lines.push(`- function rows the oracle does not have: ${r.functions.fp.map((x) => `\`${x}\``).join(', ')}`);
    if (r.functions.fn.length) lines.push(`- oracle changes the pipeline missed: ${r.functions.fn.map((x) => `\`${x}\``).join(', ')}`);
    if (r.functions.outOfScope.length) lines.push(`- pipeline rows outside the oracle's scope (tests, docs, scripts): ${r.functions.outOfScope.length}`);
    for (const k of r.kinds.filter((x) => !x.ok)) lines.push(`- kind disagreement \`${k.id}\`: got [${k.kinds}], missing [${k.missing}], extra [${k.extra}]; base \`${k.baseHeader}\` head \`${k.headHeader}\`${k.newRaises.length ? ` new raises ${k.newRaises}` : ''}`);
    for (const c of r.callers) {
      for (const x of c.falsePositives) lines.push(`- caller of \`${c.id}\` Jedi does not have: \`${x.caller}\` at ${x.file}:${x.lines.join(',')} \`${(x.code || []).join(' | ')}\``);
      for (const x of c.missed) lines.push(`- Jedi caller of \`${c.id}\` missed: \`${x.caller}\` at ${x.sites.map((s) => `${s.rel}:${s.line}`).join(', ')} (ours: ${c.callerState}, ${c.complete ? '**complete**' : `incomplete: ${c.incompleteReason}`})`);
      if (c.fineWithNotUpdated) lines.push(`- **fine while Jedi has a non-updated caller**: \`${c.id}\` [${c.kinds}] verdict "${c.verdict}"; ${c.notUpdated.slice(0, 3).join(', ')}`);
    }
    if (r.notAnalysed.length) lines.push(`- not analysed: ${r.notAnalysed.join('; ')}`);
    if (r.scopeViolations && r.scopeViolations.length) lines.push(`- **rows not incomplete with the syntax-only ${r.scope} scope, or reading none / "no callers"**: ${r.scopeViolations.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const repo = args[0];
  const worktree = option(args, '--worktree', '');
  if (!repo || !path.isAbsolute(repo) || !worktree || !path.isAbsolute(worktree)) {
    throw new Error('usage: node py-verify.js <absolute path to httpx clone> --worktree <absolute path> [--prs n,n] [--corpus file.json] [--pyright path] [--jedi-python path] [--out dir] [--summary file] [--cache dir] [--no-cache] [--deadline-ms n]');
  }
  const pyrightPath = option(args, '--pyright', DEFAULT_PYRIGHT);
  const jediPython = option(args, '--jedi-python', JEDI_PYTHON);
  const out = option(args, '--out', path.join(os.tmpdir(), 'impact-tree-p7'));
  const only = option(args, '--prs', '');
  const cacheRoot = args.includes('--no-cache') ? null : option(args, '--cache', DEFAULT_CACHE);
  const syntactic = args.includes('--syntactic');
  const preview = args.includes('--preview');
  if (preview && !syntactic) throw new Error('--preview needs --syntactic');
  packageDir = option(args, '--package', 'httpx');
  const deadlineMs = Number(option(args, '--deadline-ms', String(RUN_DEADLINE_MS)));
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RangeError('--deadline-ms must be a positive integer');
  const corpusFile = option(args, '--corpus', '');
  const all = corpusFile ? JSON.parse(fs.readFileSync(corpusFile, 'utf8')) : CORPUS;
  if (!Array.isArray(all) || !all.every((p) => Number.isInteger(p.number) && /^[0-9a-f]{40}$/.test(p.head) && /^[0-9a-f]{40}$/.test(p.base))) {
    throw new Error(`--corpus ${corpusFile}: expected an array of { number, head, base } with full commit ids`);
  }
  const corpus = only ? all.filter((p) => only.split(',').includes(String(p.number))) : all;
  if (only && corpus.length !== only.split(',').length) throw new Error(`--prs ${only}: not all in the corpus`);
  fs.mkdirSync(out, { recursive: true });
  const log = (m) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)} s] ${m}`);

  const startBranch = git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (startBranch === 'HEAD') throw new Error('the worktree is detached; put it on a branch first (it is restored to it)');
  const restore = () => { try { git(worktree, 'checkout', '-q', startBranch); } catch (e) { console.error(`could not return the worktree to ${startBranch}: ${e.message}`); } };
  const deadline = setTimeout(() => {
    console.error(`py-verify: the run exceeded its ${deadlineMs} ms budget (--deadline-ms); stopping ${children.size} child process(es). Nothing was summarised.`);
    for (const c of children) c.kill('SIGKILL');
    restore();
    process.exit(2);
  }, deadlineMs);
  try {
    const pyVersion = execFileSync('python3', ['-I', '-c', 'import sys; print(sys.version)'], { encoding: 'utf8', timeout: 30000 });
    const jediVersions = execFileSync(jediPython, ['-I', '-c', 'import sys, jedi, parso; print(sys.version.split()[0], jedi.__version__, parso.__version__)'], { encoding: 'utf8', timeout: 30000, cwd: os.tmpdir() });
    const hashes = {
      ast: sha256(AST_PROGRAM, pyVersion).slice(0, 16),
      jedi: sha256(JEDI_PROGRAM, jediVersions, AST_PROGRAM, String(JEDI_QUERY_DEADLINE_S)).slice(0, 16),
    };
    log(`${corpus.length} PRs; python ${pyVersion.split(' ')[0]}; Jedi python/jedi/parso ${jediVersions.trim()}; cache ${cacheRoot || 'off'}; ast ${hashes.ast}, jedi ${hashes.jedi}; budget ${(deadlineMs / 1000).toFixed(0)} s`);
    const usePr = semaphore(ORACLE_CONCURRENCY);
    const oraclePromises = new Map(corpus.map((pr) => [pr.number, usePr(() => oraclesFor({ repo, pr, hashes, cacheRoot, jediPython, log }))]));
    for (const p of oraclePromises.values()) p.catch(() => {});
    const records = [];
    for (const pr of corpus) {
      const pipeline = await pipelineFor(worktree, pr, pyrightPath, syntactic, preview);
      log(`#${pr.number} pipeline: Pyright ${pipeline.startMs} ms, first result ${pipeline.firstMs} ms, full ${pipeline.fullMs} ms`);
      const oracles = await oraclePromises.get(pr.number);
      const cmp = comparePr({ worktree, pr, result: pipeline.result, oracle: oracles.oracle, jedi: oracles.jedi, syntactic, indexed: pipeline.indexed || null, preview });
      const record = {
        ...pr, ...cmp, jediVersion: oracles.jedi.jedi, parsoVersion: oracles.jedi.parso, jediCheck: oracles.jedi.check,
        timing: { oracleMs: oracles.oracleMs, cachedOracles: oracles.cachedOracles, pyrightStartMs: pipeline.startMs, firstMs: pipeline.firstMs, fullMs: pipeline.fullMs },
      };
      records.push(record);
      const f = record.functions;
      log(`#${pr.number} compared: functions ${f.tp}/${f.oracle} (${f.fp.length} extra, ${f.fn.length} missed), kinds ${record.kinds.filter((k) => k.ok).length}/${record.kinds.length}, ${record.callers.filter((c) => c.missedWhileComplete).length} complete answers missing a Jedi caller${syntactic ? `, ${record.scopeViolations.length} scope violations; callers ${record.callers.reduce((s, c) => s + c.truePositives, 0)} right of ${record.callers.reduce((s, c) => s + c.ours, 0)} ours / ${record.callers.reduce((s, c) => s + c.jedi, 0)} Jedi in ${record.indexedFiles} indexed files` : ''}`);
    }
    // Written only when every PR compared: a failed run leaves no partial result behind.
    for (const r of records) fs.writeFileSync(path.join(out, `${r.number}.json`), JSON.stringify(r, null, 1));
  } finally {
    clearTimeout(deadline);
    restore();
  }
  const summary = summarise(out, corpus);
  const summaryFile = option(args, '--summary', path.join(out, 'summary.md'));
  fs.writeFileSync(summaryFile, summary);
  const total = summary.split('\n').find((l) => l.startsWith('TOTAL'));
  if (total) log(total);
  log(`done; summary in ${summaryFile}`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
