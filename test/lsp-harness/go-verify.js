'use strict';
/**
 * G7 (docs/MULTI_LANGUAGE_PLAN.md): the real pipeline and Go provider against gopls on a
 * corpus of merged cli/cli pull requests (./go-verify-corpus.json), checked against two
 * oracles that share no code with the engine. A development script, not part of `npm test`:
 * it needs gopls, the Go toolchain (`--toolchain`, default go1.27.3: at least as new as the
 * corpus's go.mod asks, and in the module cache), golang.org/x/tools v0.52.0 in the module
 * cache, and a cli/cli clone. Results: test/lsp-harness/G7-REPORT.md.
 *
 *   node test/lsp-harness/go-verify.js <absolute path to cli/cli clone>
 *     [--prs 14752,14390] [--gopls path] [--toolchain go1.27.3] [--out dir] [--summary file]
 *     [--cache dir] [--no-cache] [--timings [14752,14390]] [--deadline-ms n] [--summary-only]
 *     [--syntactic [--preview]]
 *
 * `--syntactic` (S3, S4): the pipeline runs without a language server, as the CLI does, so Go
 * is read from its text (`goProvider.prepareSyntactic`): no gopls is started. Changed
 * functions and kinds are compared with oracle (a) as in the default mode; callers with
 * oracle (b) restricted to the indexed files (an edge counts when its call site is in a file
 * the index read): the CLI's scope, every Go file of the changed module(s) (S-D1 (a)).
 * Every changed Go row must be incomplete (`completeAnswers` counts those that are not), never
 * `none`, and no verdict may read "no callers" (`noCallersRows`). `--timings` does not apply.
 * `--preview` (with `--syntactic`): the preview's scope instead. `analyzeRemote` runs offline
 * with a fake `gh` that reads only the clone's git objects (as py-verify.js `--preview`), so
 * the index holds the PR's Go files and changed Go tests the preview fetched; oracle (b) is
 * restricted to those files (the head-side Go paths the fake `gh` served).
 *
 * Two phases, run side by side:
 * - Oracles, per PR (at most ORACLE_CONCURRENCY PRs at once, at most GRAPHS_CONCURRENCY
 *   call-graph processes at once). The head commit is exported with `git archive` into a
 *   temporary directory (the clone's worktree and .git are not touched, so PRs do not share
 *   a checkout). Then
 *   (a) changed functions: GO_PROGRAM (standard library only) parses both sides of every
 *       changed non-test Go file with go/parser and lists each FuncDecl whose source text
 *       (`func` to `}`) changed, was added or removed, keyed as the provider keys them
 *       (receiver base type + name, repeats `#2`), with its header and parameters as
 *       go/printer prints them; it also indexes every FuncDecl's lines in the export, to
 *       name the function enclosing a call;
 *   (b) callers: GRAPHS_PROGRAM, cmd/callgraph's `-test -algo static` and `-algo vta` over
 *       `./...` of each module the PR changes (nearest go.mod; after `go mod download`),
 *       from one load and SSA build, keeping the edges whose callee is a changed or added
 *       function (by its declaration position).
 * - Pipeline, per PR, one after the other (it needs the clone's worktree): checks that the
 *   local branches `base-<n>` and `pr-<n>` point at the recorded commits and the worktree is
 *   clean, checks out `pr-<n>`, starts a fresh gopls and runs `analyze()` as go-e2e.js does
 *   (Go provider, the harness's gopls services, the harness resolver with Go's editor
 *   extras), with the editor's options (skipForest, test reach deferred). With `--timings`
 *   (all PRs, or the listed ones), the pipeline phase waits for the oracles so the machine
 *   is otherwise idle, and each timed PR is analysed twice: cold (a fresh gopls, timed from
 *   its spawn) and warm (the same gopls again). Without it, the times recorded are taken
 *   while the oracles run, and only say how long that run took.
 * Then each PR is compared (`comparePr`) into `<out>/<n>.json`, and every PR's JSON is
 * summarised into `--summary` (Markdown, default `<out>/summary.md`).
 *
 * Cache. An oracle's answer depends only on the two commits and the tools, so it is kept in
 * `--cache` (default DEFAULT_CACHE, outside the repository) as
 * `<head sha>-<base sha>/<funcs|graphs>-<tool hash>.json`: `funcs` is oracle (a) (its changes,
 * the head index, the changed lines and modules), `graphs` oracle (b)'s kept edges. The tool
 * hash is a SHA-256 over GO_PROGRAM and `go version` for (a), and over GRAPHS_PROGRAM, the
 * x/tools version, the toolchain and GO_PROGRAM (the kept edges depend on (a)'s callees) for
 * (b). A changed tool or commit is a different file; nothing is invalidated in place, and
 * the directory may be deleted at any time. After a fix in src/, a re-run only re-runs the
 * pipeline. `--no-cache` neither reads nor writes it.
 *
 * Budget. The whole run has a deadline (`--deadline-ms`, default RUN_DEADLINE_MS): when it
 * passes, every child process (gopls, the oracles, go) is killed, the clone is put back on
 * its branch, and the run exits with code 2 and says so; nothing partial is summarised.
 *
 * The clone is data: nothing in it is run. Only git, `go mod download`, `go list` (which the
 * call-graph program calls), gopls and the two oracle programs read it or its export; the
 * programs are built in a temporary directory. The clone is left on the branch it was on.
 * Wall-clock time is fine here: this is a measurement script, not src/.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFileSync, spawn } = require('node:child_process');
const { analyze } = require('../../src/engine/analyze');
const { createGoplsServices } = require('./gopls-services');
const { languageServicesOver, createHierarchyResolver } = require('./harness-languages');
const { goProvider } = require('../../src/languages/go/provider');
const { classifyChangeVerdict, toneOf } = require('../../src/tree-row-models');

/**
 * The corpus: merged cli/cli pull requests. `merge` is the merge commit on trunk, `head` its
 * second parent, `base` merge-base(merge^1, merge^2). `why` is what the PR was chosen for.
 */
const CORPUS = require('./go-verify-corpus.json');

/**
 * The whole run, in milliseconds. Measured on the G7 machine for the 10-PR corpus: see
 * G7-REPORT.md ("Running it"); past this the run fails (exit 2) instead of hanging.
 */
const RUN_DEADLINE_MS = 9 * 60 * 1000;
/** PRs whose oracles run at once. */
const ORACLE_CONCURRENCY = 3;
/**
 * Call-graph processes at once, across PRs. One over cli/cli with tests takes about 17 s
 * alone, several cores and 3 GB; three fit in the G7 machine's 16 GB.
 */
const GRAPHS_CONCURRENCY = 3;
const { scratchpadPath } = require('./scratchpad');
const DEFAULT_CACHE = scratchpadPath('g7', 'cache');

/** @param {string[]} args @param {string} flag @param {string} fallback */
const option = (args, flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };

/** @param {string} repo @param {string[]} args */
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });

/** Every child process this run started and has not seen exit; killed at the deadline. */
const children = new Set();
/** @param {import('node:child_process').ChildProcess} proc */
function track(proc) {
  children.add(proc);
  proc.on('exit', () => children.delete(proc));
  return proc;
}

/** Runs a command to completion; rejects with its stderr on failure. */
function run(cmd, args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = track(spawn(cmd, args, { cwd, env: { ...process.env, GOFLAGS: '' }, stdio: ['pipe', 'pipe', 'pipe'] }));
    const out = [];
    let err = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { if (err.length < 65536) err += d; });
    proc.on('error', reject);
    proc.on('close', (code, signal) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8'))
      : reject(new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} exited ${code ?? signal}: ${err.slice(0, 2000)}`))));
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

// The oracle. Field names are exported Go names (no struct tags, so no backquotes here).
const GO_PROGRAM = String.raw`package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Field struct {
	Name     string
	Type     string
	Variadic bool
}

type Func struct {
	Key       string
	Header    string
	Text      string
	NameLine  int
	StartLine int
	EndLine   int
	Recv      *string
	TParams   []Field
	Params    []Field
	Results   []Field
}

type Change struct {
	Rel    string
	Key    string
	Status string
	Base   *Func
	Head   *Func
}

type Pair struct {
	Rel      string
	BaseFile string
	HeadFile string
}

type Job struct {
	Pairs     []Pair
	IndexRoot string
}

type Span struct {
	Key       string
	NameLine  int
	StartLine int
	EndLine   int
}

type Out struct {
	Changes   []Change
	Index     map[string][]Span
	Generated []string
	Errors    []string
}

func typ(fset *token.FileSet, e ast.Expr) string {
	var b bytes.Buffer
	printer.Fprint(&b, fset, e)
	return b.String()
}

func expand(fset *token.FileSet, fl *ast.FieldList) []Field {
	out := []Field{}
	if fl == nil {
		return out
	}
	for _, f := range fl.List {
		_, v := f.Type.(*ast.Ellipsis)
		t := typ(fset, f.Type)
		if len(f.Names) == 0 {
			out = append(out, Field{"", t, v})
		}
		for _, n := range f.Names {
			out = append(out, Field{n.Name, t, v})
		}
	}
	return out
}

// The receiver's base type name: T for T, *T, T[K], *T[K, V], (T).
func recvBase(e ast.Expr) string {
	for {
		switch x := e.(type) {
		case *ast.StarExpr:
			e = x.X
		case *ast.ParenExpr:
			e = x.X
		case *ast.IndexExpr:
			e = x.X
		case *ast.IndexListExpr:
			e = x.X
		case *ast.Ident:
			return x.Name
		default:
			return "?"
		}
	}
}

func funcsOf(fset *token.FileSet, f *ast.File, src []byte, full bool) []Func {
	seen := map[string]int{}
	out := []Func{}
	for _, d := range f.Decls {
		fd, ok := d.(*ast.FuncDecl)
		if !ok {
			continue
		}
		key := fd.Name.Name
		if fd.Recv != nil && len(fd.Recv.List) > 0 {
			key = "(" + recvBase(fd.Recv.List[0].Type) + ")." + fd.Name.Name
		}
		seen[key]++
		if n := seen[key]; n > 1 {
			key = key + "#" + strconv.Itoa(n)
		}
		x := Func{
			Key:       key,
			NameLine:  fset.Position(fd.Name.Pos()).Line,
			StartLine: fset.Position(fd.Pos()).Line,
			EndLine:   fset.Position(fd.End()).Line,
		}
		if full {
			s := fset.Position(fd.Pos()).Offset
			e := fset.Position(fd.End()).Offset
			x.Text = string(src[s:e])
			he := e
			if fd.Body != nil {
				he = fset.Position(fd.Body.Lbrace).Offset
			}
			x.Header = strings.Join(strings.Fields(string(src[s:he])), " ")
			if fd.Recv != nil && len(fd.Recv.List) > 0 {
				t := typ(fset, fd.Recv.List[0].Type)
				x.Recv = &t
			}
			x.TParams = expand(fset, fd.Type.TypeParams)
			x.Params = expand(fset, fd.Type.Params)
			x.Results = expand(fset, fd.Type.Results)
		}
		out = append(out, x)
	}
	return out
}

func main() {
	var job Job
	if err := json.NewDecoder(os.Stdin).Decode(&job); err != nil {
		panic(err)
	}
	out := Out{Changes: []Change{}, Index: map[string][]Span{}, Generated: []string{}, Errors: []string{}}
	for _, p := range job.Pairs {
		fset := token.NewFileSet()
		var base, head []Func
		generated, failed := false, false
		for side, file := range []string{p.BaseFile, p.HeadFile} {
			if file == "" {
				continue
			}
			src, err := os.ReadFile(file)
			if err != nil {
				out.Errors = append(out.Errors, p.Rel+": "+err.Error())
				failed = true
				break
			}
			f, err := parser.ParseFile(fset, file, src, parser.SkipObjectResolution|parser.ParseComments)
			if err != nil {
				out.Errors = append(out.Errors, p.Rel+": "+err.Error())
				failed = true
				break
			}
			if ast.IsGenerated(f) {
				generated = true
			}
			if side == 0 {
				base = funcsOf(fset, f, src, true)
			} else {
				head = funcsOf(fset, f, src, true)
			}
		}
		if failed {
			continue
		}
		if generated {
			out.Generated = append(out.Generated, p.Rel)
			continue
		}
		byKey := map[string]*Func{}
		for i := range base {
			byKey[base[i].Key] = &base[i]
		}
		headKeys := map[string]bool{}
		for i := range head {
			h := &head[i]
			headKeys[h.Key] = true
			if b := byKey[h.Key]; b == nil {
				out.Changes = append(out.Changes, Change{p.Rel, h.Key, "added", nil, h})
			} else if b.Text != h.Text {
				out.Changes = append(out.Changes, Change{p.Rel, h.Key, "changed", b, h})
			}
		}
		for i := range base {
			if !headKeys[base[i].Key] {
				out.Changes = append(out.Changes, Change{p.Rel, base[i].Key, "removed", &base[i], nil})
			}
		}
	}
	if job.IndexRoot != "" {
		root := job.IndexRoot
		filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if info.IsDir() {
				if n := info.Name(); n == ".git" || n == "vendor" || n == "node_modules" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(p, ".go") {
				return nil
			}
			src, err := os.ReadFile(p)
			if err != nil {
				return nil
			}
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, p, src, parser.SkipObjectResolution)
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(root, p)
			spans := []Span{}
			for _, fn := range funcsOf(fset, f, src, false) {
				spans = append(spans, Span{fn.Key, fn.NameLine, fn.StartLine, fn.EndLine})
			}
			out.Index[filepath.ToSlash(rel)] = spans
			return nil
		})
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
`;

/** The golang.org/x/tools version GRAPHS_PROGRAM is built with (cmd/callgraph's, v0.52.0). */
const GRAPHS_TOOLS_VERSION = 'v0.52.0';

// Oracle (b): cmd/callgraph's two algorithms over one load and one SSA build, which halves
// the work of running `callgraph -algo static` and `callgraph -algo vta` (17 s instead of
// about 37 s on cli/cli), with the same configuration as cmd/callgraph's doCallgraph.
const GRAPHS_PROGRAM = String.raw`// Both call graphs of cmd/callgraph (x/tools v0.52.0, doCallgraph) over one SSA build:
// the same packages.Config (LoadAllSyntax, tests), ssa.InstantiateGenerics, static.CallGraph
// and vta.CallGraph(ssautil.AllFunctions(prog), nil), each with DeleteSyntheticNodes.
// Usage: graphs <callee positions file> <package patterns...>; run in the module directory.
// Prints "algo\tcaller\tcallee\tcalleeFile:line\tsiteFile\tline\tcolumn\tdynamic" for each
// edge whose callee is a named function declared at one of the positions ("file:line").
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/tools/go/callgraph"
	"golang.org/x/tools/go/callgraph/static"
	"golang.org/x/tools/go/callgraph/vta"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	callees := map[string]bool{}
	for _, l := range strings.Split(string(data), "\n") {
		if l != "" {
			callees[l] = true
		}
	}
	cfg := &packages.Config{Mode: packages.LoadAllSyntax, BuildFlags: []string{"-tags="}, Tests: true}
	initial, err := packages.Load(cfg, os.Args[2:]...)
	if err != nil {
		panic(err)
	}
	if packages.PrintErrors(initial) > 0 {
		fmt.Fprintln(os.Stderr, "packages contain errors")
		os.Exit(1)
	}
	prog, _ := ssautil.AllPackages(initial, ssa.InstantiateGenerics)
	prog.Build()
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	emit := func(algo string, cg *callgraph.Graph) {
		cg.DeleteSyntheticNodes()
		callgraph.GraphVisitEdges(cg, func(e *callgraph.Edge) error {
			callee := e.Callee.Func
			cp := prog.Fset.Position(callee.Pos())
			if !callees[fmt.Sprintf("%s:%d", cp.Filename, cp.Line)] || strings.Contains(callee.String(), "$") {
				return nil
			}
			site := prog.Fset.Position(e.Pos())
			dynamic := "static"
			if e.Site != nil && e.Site.Common().StaticCallee() == nil {
				dynamic = "dynamic"
			}
			fmt.Fprintf(out, "%s\t%s\t%s\t%s:%d\t%s\t%d\t%d\t%s\n", algo, e.Caller.Func, callee, cp.Filename, cp.Line, site.Filename, site.Line, site.Column, dynamic)
			return nil
		})
	}
	emit("static", static.CallGraph(prog))
	emit("vta", vta.CallGraph(ssautil.AllFunctions(prog), nil))
}
`;

/**
 * Builds both oracle programs in a fresh temporary directory. GRAPHS_PROGRAM needs
 * golang.org/x/tools at GRAPHS_TOOLS_VERSION from the module cache (GOPROXY=off: nothing is
 * downloaded) and a toolchain at least as new as the corpus's go.mod (`--toolchain`).
 * @returns {{ dir: string, oracle: string, graphs: string }}
 */
function buildPrograms(toolchain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-g7-programs-'));
  const build = (name, source, goMod, env) => {
    const src = path.join(dir, `${name}-src`);
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'main.go'), source);
    fs.writeFileSync(path.join(src, 'go.mod'), goMod);
    const bin = path.join(dir, name);
    execFileSync('go', ['build', '-o', bin, '.'], { cwd: src, env: { ...process.env, GOFLAGS: '', ...env }, stdio: 'inherit' });
    return bin;
  };
  return {
    dir,
    oracle: build('oracle', GO_PROGRAM, 'module oracle\n\ngo 1.21\n', { GOTOOLCHAIN: 'local' }),
    graphs: build('graphs', GRAPHS_PROGRAM, `module g7graphs\n\ngo 1.26\n\nrequire golang.org/x/tools ${GRAPHS_TOOLS_VERSION}\n`,
      { GOTOOLCHAIN: toolchain, GOFLAGS: '-mod=mod', GOPROXY: 'off' }),
  };
}

// The file rules, written again from the go tool's conventions rather than taken from
// src/languages/go/rules.js, so a disagreement shows. Generated files are left to the
// oracle (go/ast's IsGenerated, the official rule).
const isGoSource = (rel) => /\.go$/.test(rel) && !/_test\.go$/.test(rel) && !/(^|\/)(testdata|vendor)\//.test(rel);

/**
 * The changed Go files between `base` and `head` (renames followed), as the oracle's pairs.
 * Writes each side to `<work>/base/...` and `<work>/head/...` from git.
 */
function changedGoPairs(repo, base, head, work) {
  const rows = git(repo, 'diff', '--name-status', '-M', base, head, '--', '*.go').trim().split('\n').filter(Boolean);
  const pairs = [];
  for (const row of rows) {
    const parts = row.split('\t');
    const status = parts[0][0];
    const oldRel = parts[1];
    const rel = parts[parts.length - 1];
    if (!isGoSource(rel) && !(status === 'D' && isGoSource(oldRel))) continue;
    const pair = { Rel: rel, BaseFile: '', HeadFile: '' };
    for (const [side, sha, p] of [['base', base, oldRel], ['head', head, rel]]) {
      if ((side === 'base' && status === 'A') || (side === 'head' && status === 'D')) continue;
      const f = path.join(work, side, p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, execFileSync('git', ['-C', repo, 'show', `${sha}:${p}`], { maxBuffer: 1 << 28 }));
      pair[side === 'base' ? 'BaseFile' : 'HeadFile'] = f;
    }
    pairs.push(pair);
  }
  return pairs;
}

/** Head-side changed line numbers per repository-relative path, from `git diff -U0`. */
function headChangedLines(repo, base, head) {
  const text = git(repo, 'diff', '-U0', '-M', '--no-color', base, head, '--', '*.go');
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

/** The modules (directories with a go.mod, `.` for the root) the PR's changed Go files are in. */
function modulesOf(repo, base, head) {
  const mods = new Set(git(repo, 'ls-tree', '-r', '--name-only', head).split('\n')
    .filter((f) => f === 'go.mod' || f.endsWith('/go.mod')).map((f) => path.posix.dirname(f)));
  const out = new Set();
  for (const f of git(repo, 'diff', '--name-only', base, head, '--', '*.go').trim().split('\n').filter(Boolean)) {
    let dir = path.posix.dirname(f);
    while (dir !== '.' && !mods.has(dir)) dir = path.posix.dirname(dir);
    if (mods.has(dir)) out.add(dir);
  }
  return [...out].sort();
}

/**
 * Runs GRAPHS_PROGRAM in `moduleDir` (inside `exportRoot`): both call graphs, keeping the
 * edges whose callee is declared at one of `callees` (`<rel>:<name line>`). Paths are made
 * relative to `exportRoot`; a call site outside it (a dependency, the standard library) has
 * `siteRel: null`. A closure (`$` in its name) is never a callee: only named functions and
 * methods are changed-function rows.
 * @returns {Promise<{ static: { edges: object[] }, vta: { edges: object[] } }>}
 */
async function graphEdges(bin, exportRoot, moduleDir, callees) {
  const relOf = (abs) => { const r = path.relative(exportRoot, abs).split(path.sep).join('/'); return r.startsWith('..') ? null : r; };
  const list = fs.mkdtempSync(path.join(os.tmpdir(), 'it-g7-callees-'));
  const listFile = path.join(list, 'callees.txt');
  fs.writeFileSync(listFile, [...callees].map((k) => path.join(exportRoot, k)).join('\n'));
  try {
    const text = await run(bin, [listFile, './...'], { cwd: moduleDir });
    const out = { static: { edges: [] }, vta: { edges: [] } };
    const seen = new Set();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const [algo, caller, , calleeAt, siteFile, siteLine, siteCol, dynamic] = line.split('\t');
      const colon = calleeAt.lastIndexOf(':');
      const calleeKey = `${relOf(calleeAt.slice(0, colon))}:${calleeAt.slice(colon + 1)}`;
      const siteRel = relOf(siteFile);
      const id = `${algo}|${calleeKey}|${siteRel ?? siteFile}:${siteLine}:${siteCol}`;
      if (seen.has(id)) continue; // the test variant of a package repeats its functions
      seen.add(id);
      out[algo].edges.push({ caller, callee: calleeKey, siteRel, siteFile: siteRel ? null : siteFile, siteLine: Number(siteLine), dynamic });
    }
    return out;
  } finally {
    fs.rmSync(list, { recursive: true, force: true });
  }
}

/** Reads `file` (JSON) from the cache, or computes and writes it. `cacheDir` null: no cache. */
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

/**
 * Both oracles for one PR, from the cache when it has them. The head commit is exported
 * only when something must be computed.
 */
async function oraclesFor({ repo, pr, oracleBin, graphsBin, hashes, cacheRoot, useGraphs, log }) {
  const started = Date.now();
  const cacheDir = cacheRoot ? path.join(cacheRoot, `${pr.head}-${pr.base}`) : null;
  let exportRoot = null;
  let exported = null;
  const ensureExport = () => (exported ??= (async () => {
    // The real path: the go tool reports files by it (macOS's /var is /private/var).
    exportRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `it-g7-${pr.number}-tree-`)));
    await run('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, pr.head, exportRoot]);
    return exportRoot;
  })());
  try {
    const funcs = await cached(cacheDir, `funcs-${hashes.oracle}.json`, async () => {
      const root = await ensureExport();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `it-g7-${pr.number}-sides-`));
      try {
        const pairs = changedGoPairs(repo, pr.base, pr.head, work);
        const out = JSON.parse(await run(oracleBin, [], { input: JSON.stringify({ Pairs: pairs, IndexRoot: root }) }));
        return { ...out, changedLines: headChangedLines(repo, pr.base, pr.head), modules: modulesOf(repo, pr.base, pr.head) };
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
    const oracle = funcs.value;
    const callees = new Set(oracle.Changes.filter((o) => o.Status !== 'removed').map((o) => `${o.Rel}:${o.Head.NameLine}`));
    const graphs = await cached(cacheDir, `graphs-${hashes.graphs}.json`, async () => {
      const root = await ensureExport();
      for (const m of oracle.modules) await run('go', ['mod', 'download'], { cwd: path.join(root, m) });
      const all = { static: { edges: [] }, vta: { edges: [] } };
      for (const m of oracle.modules) {
        const g = await useGraphs(() => graphEdges(graphsBin, root, path.join(root, m), callees));
        all.static.edges.push(...g.static.edges);
        all.vta.edges.push(...g.vta.edges);
      }
      return all;
    });
    const staticCg = { value: graphs.value.static };
    const vtaCg = { value: graphs.value.vta };
    if (callees.size && !vtaCg.value.edges.length && !staticCg.value.edges.length) {
      throw new Error(`#${pr.number}: the call graphs kept no edge for ${callees.size} changed functions; the callee positions do not match (paths?)`);
    }
    const hits = [funcs.hit, graphs.hit].filter(Boolean).length;
    log(`#${pr.number} oracles: ${oracle.Changes.length} function changes, static ${staticCg.value.edges.length} edges kept, vta ${vtaCg.value.edges.length} (${hits}/2 cached, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return { oracle, staticCg: staticCg.value, vtaCg: vtaCg.value };
  } finally {
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

/**
 * Runs the pipeline once; `firstMs` is when `onPrepared` published the changed rows, `fullMs`
 * when the result was complete, both from `t0`.
 */
async function runPipeline(repo, base, services, t0) {
  let firstMs = null;
  const result = await analyze(repo, {
    mode: 'pr', base, allowLocalBase: true, skipForest: true, deferTestReach: true, depth: 2,
    languageServices: services,
    onPrepared: () => { firstMs = Date.now() - t0; },
    makeResolver: ({ language }) => {
      const extras = language === 'go' && goProvider.editorCallers
        ? goProvider.editorCallers({ ts: null, services, repoRoot: repo, trace: () => {}, filterInherited: false, onWarmupRetry: () => {} })
        : null;
      return createHierarchyResolver(services, { extras });
    },
  });
  return { result, firstMs, fullMs: Date.now() - t0 };
}

/**
 * The pipeline on one PR with a fresh gopls; with `warm`, once more on the same gopls. With
 * `syntactic`, without any language server (the CLI's path), once.
 */
async function pipelineFor(repo, pr, goplsPath, warm, syntactic = false, preview = false) {
  const n = pr.number;
  if (git(repo, 'rev-parse', `base-${n}`).trim() !== pr.base) throw new Error(`base-${n} is not ${pr.base}`);
  if (git(repo, 'rev-parse', `pr-${n}`).trim() !== pr.head) throw new Error(`pr-${n} is not ${pr.head}`);
  if (git(repo, 'status', '--porcelain', '--untracked-files=no').trim()) throw new Error('the clone has uncommitted changes');
  git(repo, 'checkout', '-q', `pr-${n}`);
  const t0 = Date.now();
  if (syntactic && preview) {
    // The preview, offline: a fake `gh` over the git objects (no checkout is read). The
    // worktree is at the head only so that call-site offsets turn into lines from disk.
    const served = new Set();
    const statusOf = { A: 'added', D: 'removed', M: 'modified' };
    const gh = {
      listPullRequestFiles: async () => {
        // Renames as GitHub lists them (src/github.js: status `renamed`, `previous_filename` as
        // `oldPath`), with git's default similarity, as the oracle's pairs follow them (`-M`).
        const files = git(repo, 'diff', '--name-status', '-M', pr.base, pr.head).trim().split('\n').filter(Boolean).map((l) => {
          const [st, a, b] = l.split('\t');
          const renamed = st[0] === 'R';
          const p = renamed ? b : a;
          const diff = git(repo, 'diff', '-M', pr.base, pr.head, '--', ...(renamed ? [a, b] : [p]));
          const at = diff.indexOf('\n@@');
          return { path: p, oldPath: renamed ? a : p, status: renamed ? 'renamed' : statusOf[st[0]] || 'modified', patch: at >= 0 ? diff.slice(at + 1) : null };
        });
        return { total: files.length, files };
      },
      fileAtRef: async (_slug, p, ref) => {
        try { const text = git(repo, 'show', `${ref}:${p}`); if (ref === pr.head) served.add(p); return text; } catch { return null; }
      },
    };
    let firstMs = null;
    const { analyzeRemote } = require('../../src/engine/analyze-remote');
    const result = await analyzeRemote({
      ts: require('typescript'), gh, slug: {}, repoRoot: repo,
      pr: { number: n, headSha: pr.head, mergeBaseSha: pr.base, baseRef: 'base' },
      onPrepared: () => { firstMs = Date.now() - t0; },
    });
    return { startMs: 0, cold: { result, firstMs, fullMs: Date.now() - t0 }, warm: null, indexed: new Set([...served].filter((p) => /\.go$/.test(p))) };
  }
  if (syntactic) {
    let firstMs = null;
    const result = await analyze(repo, {
      mode: 'pr', base: `base-${n}`, allowLocalBase: true, skipForest: true, deferTestReach: true, depth: 2,
      onPrepared: () => { firstMs = Date.now() - t0; },
    });
    // S-D1 (a): every Go file of the changed Go files' module(s) (each file's deepest go.mod;
    // cli/cli has a nested module, cli-exercise). The note must say the index is that whole set
    // (not bounded), or the restriction below would compare against files the index did not read.
    const all = git(repo, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
    const moduleDirs = all.filter((p) => path.posix.basename(p) === 'go.mod').map((p) => path.posix.dirname(p)).map((d) => (d === '.' ? '' : d));
    const moduleOf = (p) => moduleDirs.filter((d) => d === '' || p.startsWith(`${d}/`)).sort((x, y) => y.length - x.length)[0] ?? null;
    const changedModules = new Set(git(repo, 'diff', '--name-only', '--no-renames', pr.base, pr.head).split('\n').filter((p) => /\.go$/.test(p)).map(moduleOf));
    const listed = all.filter((p) => {
      if (!/\.go$/.test(p)) return false;
      const m = moduleOf(p);
      if (m === null || !changedModules.has(m)) return false;
      const inner = m ? p.slice(m.length + 1) : p;
      return !inner.split('/').slice(0, -1).some((d) => d === 'vendor' || d === 'testdata' || d.startsWith('_') || d.startsWith('.'));
    });
    const note = (result.warnings || []).find((w) => /Go callers from syntax only/.test(w)) || '';
    if (!note.includes(`(${listed.length} Go file(s) indexed)`)) throw new Error(`#${n}: the CLI's index is not the whole module (${listed.length} files): ${note}`);
    return { startMs: 0, cold: { result, firstMs, fullMs: Date.now() - t0 }, warm: null, indexed: new Set(listed) };
  }
  const gopls = createGoplsServices({ repo, goplsPath });
  track(gopls.client.proc);
  try {
    await gopls.start({ deadlineMs: 120000 });
    const startMs = Date.now() - t0;
    const services = languageServicesOver(gopls, { repoRoot: repo });
    const cold = await runPipeline(repo, `base-${n}`, services, t0);
    const second = warm ? await runPipeline(repo, `base-${n}`, services, Date.now()) : null;
    return { startMs, cold, warm: second };
  } finally {
    await gopls.close().catch((e) => console.error(`closing gopls: ${e.message}`));
  }
}

/** Type text without white space and trailing commas, as G3's oracle compares it. */
// `interface{}` and `any` are identical types (go/types.Identical; `any` is an alias), and
// go/printer prints each as written, so the oracle says so itself.
const squash = (t) => String(t || '').replace(/\binterface\s*\{\s*\}/g, 'any').replace(/,(?=[)\]])/g, '').replace(/[\s;]+/g, '');
const typesOf = (fields) => fields.map((f) => `${f.Variadic ? '...' : ''}${squash(f.Type)}`);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What a header change must and may report, from go/parser's view of both headers (no engine
 * code). `required`: kinds that must be present. `allowed`: kinds that may be. Names alone
 * (a renamed parameter) and layout are invisible to callers: they require nothing, and then
 * only `body` is right.
 */
function expectedKinds(base, head) {
  const required = new Set();
  const allowed = new Set();
  const recvChanged = squash(base.Recv) !== squash(head.Recv);
  const bt = typesOf(base.TParams), ht = typesOf(head.TParams);
  const bp = typesOf(base.Params), hp = typesOf(head.Params);
  const tparamsChanged = !same(bt, ht);
  const paramsChanged = !same(bp, hp);
  const resultsChanged = !same(typesOf(base.Results), typesOf(head.Results));
  const paramKinds = ['type-changed', 'required-param', 'optional-param', 'param-removed'];
  if (recvChanged) { required.add('type-changed'); allowed.add('type-changed'); }
  // Type parameters and parameters are one list to the engine (receiver, [T], params), so
  // an alignment may report any parameter kind for either; require that one is reported.
  if (tparamsChanged || paramsChanged) {
    paramKinds.forEach((k) => allowed.add(k));
    const longer = (hp.length + ht.length) > (bp.length + bt.length);
    const shorter = (hp.length + ht.length) < (bp.length + bt.length);
    if (longer) required.add(hp.some((t) => t.startsWith('...')) && !bp.some((t) => t.startsWith('...')) ? 'optional-param|required-param' : 'required-param|optional-param');
    else if (shorter) required.add('param-removed');
    else required.add('type-changed|param-removed');
  }
  if (resultsChanged) { required.add('return-changed'); allowed.add('return-changed'); }
  if (!required.size) allowed.add('body');
  return { required: [...required], allowed: [...allowed], recvChanged, tparamsChanged, paramsChanged, resultsChanged };
}

/** Whether `kinds` (ids) satisfy `expectedKinds`. `a|b` in `required` is either. */
function kindsAgree(kinds, expected) {
  const missing = expected.required.filter((r) => !r.split('|').some((k) => kinds.includes(k)));
  const extra = kinds.filter((k) => !expected.allowed.includes(k));
  return { ok: !missing.length && !extra.length, missing, extra };
}

const GOOS = 'aix|android|darwin|dragonfly|freebsd|hurd|illumos|ios|js|linux|nacl|netbsd|openbsd|plan9|solaris|wasip1|windows|zos';
const GOARCH = '386|amd64|arm|arm64|loong64|mips|mipsle|mips64|mips64le|ppc64|ppc64le|riscv64|s390x|wasm';
const OS_ARCH_SUFFIX = new RegExp(`_(?:${GOOS}|${GOARCH})(?:_(?:${GOARCH}))?(?:_test)?\\.go$`);
const buildConstrainedCache = new Map();
/**
 * Whether a head file builds only under some tags: a `//go:build` line before its `package`
 * clause, or a `_<os>`/`_<arch>` name. callgraph builds the default tags only, so a caller or
 * callee in such a file is outside what the oracle sees (or one variant of it).
 */
function buildConstrained(repo, rel) {
  if (!rel || rel.startsWith('external:')) return false;
  const key = path.join(repo, rel);
  if (!buildConstrainedCache.has(key)) {
    let tagged = OS_ARCH_SUFFIX.test(path.basename(rel));
    if (!tagged) {
      try { const text = fs.readFileSync(key, 'utf8'); tagged = /^\/\/go:build /m.test(text.slice(0, Math.max(0, text.search(/^package /m)))); } catch { tagged = false; }
    }
    buildConstrainedCache.set(key, tagged);
  }
  return buildConstrainedCache.get(key);
}

/**
 * Why the index missed a static call (without a server), from the call's line in the head
 * text: `method result` (`x.F().M(`), `index expression` (`xs[i].M(`), `range variable`
 * (the receiver is declared by `for … range` in the enclosing function), `untyped :=` (by
 * `:=` there), `package files outside the PR` (preview: the caller's or callee's package has
 * a Go file the index did not read, and the line gives no other cause), else `other`.
 */
function missCause({ repo, index, site, name, calleeRel, indexed, preview }) {
  let text;
  try { text = fs.readFileSync(path.join(repo, site.file), 'utf8'); } catch { return 'other'; }
  const lines = text.split('\n');
  const line = lines[site.line - 1] || '';
  const at = line.search(new RegExp(`\\.${name}\\s*[\\[(]`));
  let cause = 'other';
  if (at > 0) {
    const before = line.slice(0, at).trimEnd();
    if (/\)$/.test(before)) cause = 'method result';
    else if (/\]$/.test(before)) cause = 'index expression';
    else {
      const recv = (/([\p{L}_][\p{L}\p{N}_]*)$/u.exec(before) || [])[1];
      const span = (index[site.file] || []).find((x) => x.StartLine <= site.line && site.line <= x.EndLine);
      const body = span ? lines.slice(span.StartLine - 1, site.line).join('\n') : '';
      if (recv && new RegExp(`for\\s+(?:[\\w\\s,]*\\b${recv}\\b[\\w\\s,]*):=\\s*range\\b`).test(body)) cause = 'range variable';
      else if (recv && new RegExp(`\\b${recv}\\b(?:\\s*,\\s*\\w+)*\\s*:=`).test(body)) cause = 'untyped :=';
    }
  }
  if (preview && indexed && (cause === 'other' || cause === 'untyped :=')) {
    const dirs = [path.posix.dirname(site.file), path.posix.dirname(calleeRel)];
    const unread = dirs.some((d) => fs.readdirSync(path.join(repo, d)).some((f) => f.endsWith('.go') && !indexed.has(path.posix.join(d, f))));
    if (unread) cause = 'package files outside the PR';
  }
  return cause;
}

/**
 * Compares one PR's pipeline result with the oracles. Caller identity on every side is the
 * function that encloses the call site in the head commit (`<rel>#<key>`, `<rel>#(file)`
 * outside every function, `external:<name>` outside the repository), so gopls' items for
 * function literals (`F.func()`) and callgraph's closures (`F$1`) both count as `F`.
 */
function comparePr({ repo, pr, result, oracle, staticCg, vtaCg, syntactic = false, indexed = null, preview = false }) {
  const changedLines = oracle.changedLines;
  const index = oracle.Index;
  const lineOf = lineFinder();
  const rel = (abs) => path.relative(repo, abs).split(path.sep).join('/');
  const enclosing = (relPath, line) => {
    const spans = index[relPath];
    if (!spans) return `${relPath}#(not indexed)`;
    const s = spans.find((x) => x.StartLine <= line && line <= x.EndLine);
    return `${relPath}#${s ? s.Key : '(file)'}`;
  };
  const siteId = (absFile, line) => {
    const r = rel(absFile);
    return r.startsWith('..') ? null : enclosing(r, line);
  };

  // (a) changed functions.
  // Only Go rows: a PR's TypeScript or JavaScript files have their own provider.
  const isGo = (x) => /\.go$/.test(x.relPath);
  const pipelineRows = [
    ...result.allChanged.filter(isGo).map((c) => ({ id: `${c.relPath}#${c.key}|${c.added ? 'added' : 'changed'}`, c })),
    ...result.deleted.filter(isGo).map((d) => ({ id: `${d.relPath}#${d.key}|removed`, d })),
  ];
  const oracleRows = oracle.Changes.map((o) => ({ id: `${o.Rel}#${o.Key}|${o.Status}`, o }));
  const pipelineIds = new Set(pipelineRows.map((r) => r.id));
  const oracleIds = new Set(oracleRows.map((r) => r.id));
  const fp = pipelineRows.filter((r) => !oracleIds.has(r.id)).map((r) => r.id);
  const fn = oracleRows.filter((r) => !pipelineIds.has(r.id)).map((r) => r.id);
  const tp = pipelineRows.filter((r) => oracleIds.has(r.id)).length;

  // Signature kinds, for every change both see.
  const changeById = new Map(result.allChanged.map((c) => [`${c.relPath}#${c.key}`, c]));
  const kindRows = [];
  for (const o of oracle.Changes.filter((x) => x.Status === 'changed')) {
    const c = changeById.get(`${o.Rel}#${o.Key}`);
    if (!c || c.added) continue;
    const kinds = c.kinds.map((k) => k.id);
    const headerChanged = o.Base.Header !== o.Head.Header;
    const expected = headerChanged ? expectedKinds(o.Base, o.Head) : { required: [], allowed: ['body'] };
    const agree = kindsAgree(kinds, expected);
    kindRows.push({ id: `${o.Rel}#${o.Key}`, headerChanged, kinds, ...agree, expected, baseHeader: o.Base.Header, headHeader: o.Head.Header });
  }

  // (b) callers, per changed or added function both see.
  const calleeOf = new Map(); // `<rel>:<name line>` -> `<rel>#<key>`
  for (const o of oracle.Changes) if (o.Status !== 'removed') calleeOf.set(`${o.Rel}:${o.Head.NameLine}`, `${o.Rel}#${o.Key}`);
  const byCallee = (edges) => {
    const m = new Map();
    for (const e of edges) {
      const callee = calleeOf.get(e.callee);
      const caller = e.siteRel ? enclosing(e.siteRel, e.siteLine) : `external:${e.caller.replace(/\$.*$/, '')}`;
      if (!m.has(callee)) m.set(callee, new Map());
      const callers = m.get(callee);
      if (!callers.has(caller)) callers.set(caller, []);
      callers.get(caller).push({ file: e.siteRel ?? e.siteFile, line: e.siteLine, dynamic: e.dynamic });
    }
    return m;
  };
  // "Calls by name": callgraph's static algorithm, plus every statically dispatched site vta
  // sees. static.CallGraph (x/tools v0.52.0, go/callgraph/static) walks only from package
  // members along static calls, so a call inside a function literal that is stored or passed
  // (a cobra RunE, a returned closure) is never visited, and package initialisers go with
  // the synthetic nodes; vta starts from every function, and its edges whose site has a
  // static callee are exactly those calls.
  const staticBy = byCallee(staticCg.edges.concat(vtaCg.edges.filter((e) => e.dynamic === 'static')));
  const vtaBy = byCallee(vtaCg.edges);
  const callerRows = [];
  for (const o of oracle.Changes.filter((x) => x.Status !== 'removed')) {
    const id = `${o.Rel}#${o.Key}`;
    const c = changeById.get(id);
    if (!c || (c.added ? 'added' : 'changed') !== o.Status) continue;
    /** @type {Map<string, { test: boolean, lines: number[], callState: string }>} */
    const ours = new Map();
    for (const x of c.callers || []) {
      const lines = (x.callSites || []).filter((s) => Number.isInteger(s.start)).map((s) => lineOf(x.file, s.start));
      const at = lines.length ? lines[0] : lineOf(x.file, x.pos);
      const callerId = siteId(x.file, at) ?? `external:${x.label}`;
      const prev = ours.get(callerId);
      if (prev) prev.lines.push(...lines);
      else ours.set(callerId, { test: !!x.test, lines, callState: x.callState, label: x.label });
    }
    const st = staticBy.get(id) || new Map();
    const vt = vtaBy.get(id) || new Map();
    // Without a server, only callers in the files the index read can be found (`indexed`).
    const inRepo = (k) => !k.startsWith('external:') && (!indexed || indexed.has(k.slice(0, k.indexOf('#'))));
    const isTest = (k) => /_test\.go#/.test(k);
    const staticIds = [...st.keys()].filter(inRepo);
    const vtaIds = [...vt.keys()].filter((k) => !indexed || inRepo(k));
    const ourIds = [...ours.keys()];
    const falsePositives = ourIds.filter((k) => !st.has(k)).map((k) => ({
      caller: k, inVta: vt.has(k), lines: ours.get(k).lines,
      buildTag: buildConstrained(repo, k.slice(0, k.indexOf('#'))) || buildConstrained(repo, o.Rel),
    }));
    const missedStatic = staticIds.filter((k) => !ours.has(k)).map((k) => ({
      caller: k, sites: st.get(k),
      cause: syntactic ? missCause({ repo, index, site: st.get(k)[0], name: o.Key.replace(/^\([^)]*\)\./, '').replace(/#\d+$/, ''), calleeRel: o.Rel, indexed, preview }) : null,
    }));
    const missedVta = vtaIds.filter((k) => !ours.has(k)).map((k) => ({ caller: k, sites: vt.get(k), static: st.has(k) }));
    // A vta caller in the repository, not a test, whose call line the PR did not touch.
    const notUpdated = vtaIds.filter((k) => inRepo(k) && !isTest(k)).filter((k) => {
      const relPath = k.slice(0, k.indexOf('#'));
      const touched = new Set(changedLines[relPath] || []);
      return vt.get(k).some((s) => !touched.has(s.line));
    });
    const verdict = classifyChangeVerdict(c);
    const fine = toneOf(verdict) === null;
    const risky = c.kinds.some((k) => k.id !== 'body');
    callerRows.push({
      id, status: o.Status, kinds: c.kinds.map((k) => k.id), callerState: c.callerState,
      complete: c.callersComplete, incompleteReason: c.callersIncompleteReason,
      verdict: verdict.text, level: verdict.level, fine,
      ours: ourIds.length, static: staticIds.length, vta: vtaIds.length,
      truePositives: ourIds.filter((k) => st.has(k)).length,
      falsePositives, missedStatic, missedVta,
      vtaMissedWhileComplete: missedVta.length > 0 && c.callersComplete !== false,
      notUpdatedVta: notUpdated,
      fineWithNotUpdated: risky && fine && notUpdated.length > 0,
      quietWithVtaCallers: !risky && fine && c.callerState === 'none' && vtaIds.length > 0,
      noCallersRow: c.callerState === 'none' || /no callers/i.test(`${verdict.sentence || ''} ${verdict.text || ''}`),
    });
  }
  return {
    pr: pr.number,
    ...(syntactic ? {
      syntactic: true, scope: preview ? 'preview' : 'cli', indexedFiles: indexed ? indexed.size : null,
      completeAnswers: result.allChanged.filter(isGo).filter((c) => c.callersComplete !== false).length,
      noCallersRows: result.allChanged.filter(isGo).filter((c) => c.callerState === 'none' || /no callers/i.test(classifyChangeVerdict(c).sentence || '')).map((c) => `${c.relPath}#${c.key}`),
      goRows: result.allChanged.filter(isGo).length,
    } : {}),
    functions: { tp, fp, fn, pipeline: pipelineRows.length, oracle: oracleRows.length },
    kinds: kindRows,
    callers: callerRows,
    generatedByOracle: oracle.Generated,
    oracleErrors: oracle.Errors,
    warnings: result.warnings,
    unanalysable: [...Object.entries(result.unanalysable || {})],
    notAnalysed: (result.otherFiles || []).filter((f) => f.notAnalysed).map((f) => `${f.path}: ${f.notAnalysed}`),
  };
}

const pct = (a, b) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`);

/** Markdown tables from every `<out>/<n>.json` of the corpus. */
function summarise(out, corpus) {
  const records = corpus.map((p) => path.join(out, `${p.number}.json`)).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const lines = [];
  const T = { tp: 0, fp: 0, fn: 0, kinds: 0, kindsOk: 0, header: 0, headerOk: 0, ours: 0, st: 0, ctp: 0, cfp: 0, cfpVta: 0, cfpTag: 0, cfn: 0, vtaMiss: 0, vtaMissWhileComplete: 0, fineNotUpdated: 0, quiet: 0, risky: 0 };
  lines.push('| PR | Go files | functions (oracle) | precision | recall | header changes right | body-only right | callers ours / static | caller precision | caller recall | vta-missed on incomplete | fine with non-updated vta caller | first / full, fresh gopls | warm first / full |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of records) {
    const f = r.functions;
    const hdr = r.kinds.filter((k) => k.headerChanged);
    const body = r.kinds.filter((k) => !k.headerChanged);
    const ours = r.callers.reduce((s, c) => s + c.ours, 0);
    const st = r.callers.reduce((s, c) => s + c.static, 0);
    const ctp = r.callers.reduce((s, c) => s + c.truePositives, 0);
    const cfp = r.callers.reduce((s, c) => s + c.falsePositives.length, 0);
    const cfpVta = r.callers.reduce((s, c) => s + c.falsePositives.filter((x) => x.inVta).length, 0);
    const cfpTag = r.callers.reduce((s, c) => s + c.falsePositives.filter((x) => x.buildTag).length, 0);
    const cfn = r.callers.reduce((s, c) => s + c.missedStatic.length, 0);
    const vtaMiss = r.callers.filter((c) => c.missedVta.length).length;
    const vtaMissWhileComplete = r.callers.filter((c) => c.vtaMissedWhileComplete).length;
    const fineNotUpdated = r.callers.filter((c) => c.fineWithNotUpdated).length;
    const quiet = r.callers.filter((c) => c.quietWithVtaCallers).length;
    Object.assign(T, {
      tp: T.tp + f.tp, fp: T.fp + f.fp.length, fn: T.fn + f.fn.length,
      header: T.header + hdr.length, headerOk: T.headerOk + hdr.filter((k) => k.ok).length,
      kinds: T.kinds + body.length, kindsOk: T.kindsOk + body.filter((k) => k.ok).length,
      ours: T.ours + ours, st: T.st + st, ctp: T.ctp + ctp, cfp: T.cfp + cfp, cfpVta: T.cfpVta + cfpVta, cfpTag: T.cfpTag + cfpTag, cfn: T.cfn + cfn,
      vtaMiss: T.vtaMiss + vtaMiss, vtaMissWhileComplete: T.vtaMissWhileComplete + vtaMissWhileComplete,
      fineNotUpdated: T.fineNotUpdated + fineNotUpdated, quiet: T.quiet + quiet,
    });
    const t = r.timing;
    const s = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '–');
    lines.push(`| #${r.number} | ${r.goFiles} | ${f.oracle} | ${pct(f.tp, f.pipeline)} | ${pct(f.tp, f.oracle)} | ${hdr.filter((k) => k.ok).length}/${hdr.length} | ${body.filter((k) => k.ok).length}/${body.length} | ${ours} / ${st} | ${pct(ctp, ours)} | ${pct(ctp, st)} | ${vtaMiss - vtaMissWhileComplete}/${vtaMiss} | ${fineNotUpdated} | ${s(t.coldFirstMs)} / ${s(t.coldFullMs)} | ${s(t.warmFirstMs)} / ${s(t.warmFullMs)} |`);
  }
  lines.push(`| **total** | | ${T.tp + T.fn} | ${pct(T.tp, T.tp + T.fp)} | ${pct(T.tp, T.tp + T.fn)} | ${T.headerOk}/${T.header} | ${T.kindsOk}/${T.kinds} | ${T.ours} / ${T.st} | ${pct(T.ctp, T.ours)} | ${pct(T.ctp, T.st)} | ${T.vtaMiss - T.vtaMissWhileComplete}/${T.vtaMiss} | ${T.fineNotUpdated} | | |`);
  lines.push('');
  const reasons = new Map();
  let changes = 0;
  for (const r of records) for (const c of r.callers) {
    changes++;
    if (c.complete === false) reasons.set(c.incompleteReason, (reasons.get(c.incompleteReason) || 0) + 1);
  }
  lines.push(`Changed or added functions with callers compared: ${changes}; incomplete answers by reason: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  lines.push('');
  lines.push(`Caller false positives against static: ${T.cfp}, of which ${T.cfpVta} are vta edges (calls through an interface or a function value); the other ${T.cfp - T.cfpVta} neither oracle has. Missed static callers: ${T.cfn}. Body-only changes shown as "no callers" while vta finds callers: ${T.quiet}.`);
  lines.push('');
  lines.push(`Build-tag variants (oracle builds default tags): ${T.cfpTag} of the false positives have a caller or callee file with a \`//go:build\` constraint or an \`_<os>\`/\`_<arch>\` name. Caller precision ${pct(T.ctp, T.ours)} with them, ${pct(T.ctp, T.ours - T.cfpTag)} without them.`);
  const causes = new Map();
  for (const r of records) for (const c of r.callers) for (const x of c.missedStatic) if (x.cause) causes.set(x.cause, (causes.get(x.cause) || 0) + 1);
  if (causes.size) lines.push(`Missed static callers by cause: ${[...causes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  lines.push('');
  for (const r of records) {
    lines.push(`### #${r.number}`);
    lines.push('');
    if (r.functions.fp.length) lines.push(`- function rows the oracle does not have: ${r.functions.fp.map((x) => `\`${x}\``).join(', ')}`);
    if (r.functions.fn.length) lines.push(`- oracle changes the pipeline missed: ${r.functions.fn.map((x) => `\`${x}\``).join(', ')}`);
    for (const k of r.kinds.filter((x) => !x.ok)) lines.push(`- kind disagreement \`${k.id}\`: got [${k.kinds}], missing [${k.missing}], extra [${k.extra}]; base \`${k.baseHeader}\` head \`${k.headHeader}\``);
    for (const c of r.callers) {
      for (const x of c.falsePositives) lines.push(`- caller of \`${c.id}\` not in static: \`${x.caller}\`${x.buildTag ? ' (build-tag variant (oracle builds default tags))' : x.inVta ? ' (vta has it)' : ' (**neither oracle has it**)'} lines ${x.lines.join(',')}`);
      for (const x of c.missedStatic) lines.push(`- static caller of \`${c.id}\` missed: \`${x.caller}\` at ${x.sites.map((s) => `${path.basename(s.file)}:${s.line}`).join(', ')} ${x.cause ? ` [${x.cause}]` : ''} (ours: ${c.callerState}, ${c.complete ? '**complete**' : 'incomplete'})`);
      if (c.missedVta.length) lines.push(`- vta callers of \`${c.id}\` we do not list: ${c.missedVta.length} (${c.missedVta.filter((x) => !x.static).length} dynamic-only), change ${c.complete ? '**complete**' : `incomplete (${c.incompleteReason})`}, verdict "${c.verdict}"; e.g. ${c.missedVta.slice(0, 3).map((x) => `\`${x.caller}\``).join(', ')}`);
      if (c.fineWithNotUpdated) lines.push(`- **fine while vta has a non-updated caller**: \`${c.id}\` [${c.kinds}] verdict "${c.verdict}"; ${c.notUpdatedVta.slice(0, 3).join(', ')}`);
      if (c.quietWithVtaCallers) lines.push(`- body-only "no callers" while vta has ${c.vta}: \`${c.id}\``);
    }
    if (r.syntactic) {
      const missedComplete = r.callers.filter((c) => c.missedStatic.length && c.complete !== false).length;
      lines.push(`- without a server (${r.scope}, ${r.indexedFiles} Go file(s) indexed): ${r.goRows} Go rows, ${r.completeAnswers} complete caller answers, ${r.noCallersRows.length} rows reading "no callers"${r.noCallersRows.length ? `: ${r.noCallersRows.join(', ')}` : ''}; answers missing a static caller: ${r.callers.filter((c) => c.missedStatic.length).length} (${missedComplete} of them complete)`);
    }
    if (r.notAnalysed.length) lines.push(`- not analysed: ${r.notAnalysed.join('; ')}`);
    if (r.warmSameAsCold === false) lines.push('- **warm run differs from cold run**');
    lines.push('');
  }
  return lines.join('\n');
}


/** The comparison of one PR, written to `<out>/<n>.json`. */
function recordPr({ repo, pr, out, oracles, pipeline, timed, syntactic, preview }) {
  const cmp = comparePr({ repo, pr, result: pipeline.cold.result, ...oracles, syntactic, indexed: pipeline.indexed || null, preview });
  const record = {
    ...pr, ...cmp, modules: oracles.oracle.modules,
    timing: {
      idle: timed, goplsStartMs: pipeline.startMs, coldFirstMs: pipeline.cold.firstMs, coldFullMs: pipeline.cold.fullMs,
      warmFirstMs: pipeline.warm ? pipeline.warm.firstMs : null, warmFullMs: pipeline.warm ? pipeline.warm.fullMs : null,
    },
  };
  if (pipeline.warm) {
    const shape = (r) => JSON.stringify(r.allChanged.map((c) => [c.relPath, c.key, c.kinds.map((k) => k.id), c.callers.length, c.callersComplete]));
    record.warmSameAsCold = shape(pipeline.warm.result) === shape(pipeline.cold.result);
  }
  fs.writeFileSync(path.join(out, `${pr.number}.json`), JSON.stringify(record, null, 1));
  return record;
}

async function main() {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const repo = args[0];
  if (!repo || !path.isAbsolute(repo)) throw new Error('usage: node go-verify.js <absolute path to cli/cli clone> [--prs n,n] [--gopls path] [--toolchain goX.Y.Z] [--out dir] [--summary file] [--cache dir] [--no-cache] [--timings [n,n]] [--deadline-ms n] [--summary-only] [--syntactic [--preview]]');
  const goplsPath = option(args, '--gopls', path.join(os.homedir(), 'go', 'bin', 'gopls'));
  const toolchain = option(args, '--toolchain', 'go1.27.3');
  const out = option(args, '--out', path.join(os.tmpdir(), 'impact-tree-g7'));
  const only = option(args, '--prs', '');
  const cacheRoot = args.includes('--no-cache') ? null : option(args, '--cache', DEFAULT_CACHE);
  const deadlineMs = Number(option(args, '--deadline-ms', String(RUN_DEADLINE_MS)));
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RangeError('--deadline-ms must be a positive integer');
  const timingsArg = args.includes('--timings') ? option(args, '--timings', 'all') : null;
  const syntactic = args.includes('--syntactic');
  if (syntactic && timingsArg !== null) throw new Error('--timings does not apply with --syntactic');
  const preview = args.includes('--preview');
  if (preview && !syntactic) throw new Error('--preview needs --syntactic');
  fs.mkdirSync(out, { recursive: true });
  const corpus = only ? CORPUS.filter((p) => only.split(',').includes(String(p.number))) : CORPUS;
  const timedPrs = new Set(timingsArg === null ? [] : timingsArg === 'all' ? corpus.map((p) => p.number) : timingsArg.split(',').map(Number));
  const log = (m) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)} s] ${m}`);

  if (!args.includes('--summary-only')) {
    const startBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    const deadline = setTimeout(() => {
      console.error(`go-verify: the run exceeded its ${deadlineMs} ms budget (--deadline-ms); stopping ${children.size} child process(es). Nothing was summarised.`);
      for (const c of children) c.kill('SIGKILL');
      try { git(repo, 'checkout', '-q', startBranch); } catch (e) { console.error(`could not return the clone to ${startBranch}: ${e.message}`); }
      process.exit(2);
    }, deadlineMs);
    const programs = buildPrograms(toolchain);
    try {
      const goVersion = execFileSync('go', ['version'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } });
      const hashes = {
        oracle: sha256(GO_PROGRAM, goVersion).slice(0, 16),
        graphs: sha256(GRAPHS_PROGRAM, GRAPHS_TOOLS_VERSION, toolchain, GO_PROGRAM).slice(0, 16),
      };
      log(`${corpus.length} PRs; cache ${cacheRoot || 'off'}; oracle ${hashes.oracle}, graphs ${hashes.graphs}; budget ${(deadlineMs / 1000).toFixed(0)} s`);
      const useGraphs = semaphore(GRAPHS_CONCURRENCY);
      const usePr = semaphore(ORACLE_CONCURRENCY);
      const oraclePromises = new Map(corpus.map((pr) => [pr.number, usePr(() => oraclesFor({
        repo, pr, oracleBin: programs.oracle, graphsBin: programs.graphs, hashes, cacheRoot, useGraphs, log,
      }))]));
      // An oracle failure is reported when its PR is compared; keep it from being unhandled meanwhile.
      for (const p of oraclePromises.values()) p.catch(() => {});
      // Timed runs wait for the oracles, so the machine is otherwise idle while they run.
      if (timedPrs.size) await Promise.allSettled(oraclePromises.values());
      for (const pr of corpus) {
        const timed = timedPrs.has(pr.number);
        const pipeline = await pipelineFor(repo, pr, goplsPath, timed, syntactic, preview);
        log(`#${pr.number} pipeline: first result ${pipeline.cold.firstMs} ms, full ${pipeline.cold.fullMs} ms${pipeline.warm ? `; warm ${pipeline.warm.firstMs} / ${pipeline.warm.fullMs} ms` : ''}`);
        const record = recordPr({ repo, pr, out, oracles: await oraclePromises.get(pr.number), pipeline, timed, syntactic, preview });
        const f = record.functions;
        const kindsOk = `kinds ${record.kinds.filter((k) => k.ok).length}/${record.kinds.length}`;
        log(`#${pr.number} compared: functions ${f.tp}/${f.oracle} (${f.fp.length} extra, ${f.fn.length} missed), ${kindsOk}, ${syntactic
          ? `callers ${record.callers.reduce((n, c) => n + c.truePositives, 0)}/${record.callers.reduce((n, c) => n + c.ours, 0)} in static (static ${record.callers.reduce((n, c) => n + c.static, 0)}), ${record.completeAnswers} complete caller answers, ${record.noCallersRows.length} rows reading "no callers"`
          : `${record.callers.filter((c) => c.vtaMissedWhileComplete).length} complete answers missing a vta caller`}`);
      }
    } finally {
      clearTimeout(deadline);
      fs.rmSync(programs.dir, { recursive: true, force: true });
      git(repo, 'checkout', '-q', startBranch);
    }
  }
  const summary = summarise(out, CORPUS);
  const summaryFile = option(args, '--summary', path.join(out, 'summary.md'));
  fs.writeFileSync(summaryFile, summary);
  log(`done; summary in ${summaryFile}`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
