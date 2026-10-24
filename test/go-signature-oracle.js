// @ts-check
'use strict';
// Dev script, not part of `npm test`: checks parseGoDeclaration against the Go toolchain's own
// parser. Usage: node test/go-signature-oracle.js <path-to-go-repo>
// A small Go program (standard library only: go/parser, go/printer, go/ast) is written to a
// temp directory and run with the repo path as an argument; it never runs inside the repo.
// For every FuncDecl in every non-vendor, non-testdata .go file it prints the declaration's
// source text and the parameters/results as the Go parser sees them. Each is compared with
// what parseGoDeclaration reports. Types are compared with all whitespace, `;` and
// trailing commas removed, because go/printer lays out structs and long lists differently
// from the source.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseGoDeclaration } = require('../src/languages/go/signature');

const GO_PROGRAM = `package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

type field struct {
	Name     string \`json:"name"\`
	Type     string \`json:"type"\`
	Variadic bool   \`json:"variadic"\`
}

type decl struct {
	File    string  \`json:"file"\`
	Text    string  \`json:"text"\`
	Recv    *string \`json:"recv"\`
	TParams []field \`json:"tparams"\`
	Params  []field \`json:"params"\`
	Results []field \`json:"results"\`
}

func typ(fset *token.FileSet, e ast.Expr) string {
	var b bytes.Buffer
	printer.Fprint(&b, fset, e)
	return b.String()
}

func expand(fset *token.FileSet, fl *ast.FieldList) []field {
	out := []field{}
	if fl == nil {
		return out
	}
	for _, f := range fl.List {
		_, v := f.Type.(*ast.Ellipsis)
		t := typ(fset, f.Type)
		if len(f.Names) == 0 {
			out = append(out, field{"", t, v})
		}
		for _, n := range f.Names {
			out = append(out, field{n.Name, t, v})
		}
	}
	return out
}

func main() {
	root := os.Args[1]
	fset := token.NewFileSet()
	out := []decl{}
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if info.IsDir() {
			n := info.Name()
			if n == ".git" || n == "vendor" || n == "testdata" || n == "node_modules" {
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
		f, err := parser.ParseFile(fset, p, src, parser.SkipObjectResolution)
		if err != nil {
			return nil
		}
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok {
				continue
			}
			s := fset.Position(fd.Pos()).Offset
			e := fset.Position(fd.End()).Offset
			x := decl{File: rel, Text: string(src[s:e])}
			if fd.Recv != nil && len(fd.Recv.List) > 0 {
				t := typ(fset, fd.Recv.List[0].Type)
				x.Recv = &t
			}
			x.TParams = expand(fset, fd.Type.TypeParams)
			x.Params = expand(fset, fd.Type.Params)
			x.Results = expand(fset, fd.Type.Results)
			out = append(out, x)
		}
		return nil
	})
	json.NewEncoder(os.Stdout).Encode(out)
}
`;

/** @param {string} t */
const squash = (t) => t.replace(/,(?=[)\]])/g, '').replace(/[\s;]+/g, '');

/**
 * What the parser should report for an oracle declaration.
 * @param {any} d @returns {{ params: { name: string, type: string }[], returns: string | null }}
 */
function expected(d) {
  const params = [];
  if (d.recv !== null) params.push({ name: '(receiver)', type: d.recv });
  d.tparams.forEach((/** @type {any} */ f, /** @type {number} */ n) =>
    params.push({ name: `[${f.name === '_' ? `_#${n + 1}` : f.name}]`, type: f.type }));
  d.params.forEach((/** @type {any} */ f, /** @type {number} */ n) =>
    params.push({ name: f.name === '' ? `#${n + 1}` : f.name === '_' ? `_#${n + 1}` : f.name, type: f.type }));
  const rs = d.results.map((/** @type {any} */ f) => f.type);
  return { params, returns: rs.length === 0 ? null : rs.length === 1 ? rs[0] : `(${rs.join(', ')})` };
}

/** @returns {string | null} a description of the first difference, or null when they agree. */
function compare(/** @type {any} */ d) {
  const parsed = parseGoDeclaration(d.text);
  if (!parsed) return 'parseGoDeclaration returned null';
  const want = expected(d);
  const got = parsed.sig;
  if (got.params.length !== want.params.length) {
    return `param count ${got.params.length} != ${want.params.length}: got [${got.params.map((p) => `${p.name}:${p.type}`)}] want [${want.params.map((p) => `${p.name}:${p.type}`)}]`;
  }
  for (let i = 0; i < want.params.length; i++) {
    if (got.params[i].name !== want.params[i].name) return `param ${i} name ${got.params[i].name} != ${want.params[i].name}`;
    if (squash(got.params[i].type) !== squash(want.params[i].type)) return `param ${i} (${want.params[i].name}) type ${got.params[i].type} != ${want.params[i].type}`;
  }
  if (squash(got.returns || '') !== squash(want.returns || '')) return `returns ${got.returns} != ${want.returns}`;
  if (d.text[parsed.headerEnd] !== undefined && d.text[parsed.headerEnd] !== '{') return `headerEnd ${parsed.headerEnd} is not at a '{'`;
  return null;
}

function main() {
  const repo = process.argv[2];
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: node test/go-signature-oracle.js <path-to-go-repo>');
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'it-go-oracle-'));
  fs.writeFileSync(path.join(tmp, 'main.go'), GO_PROGRAM);
  fs.writeFileSync(path.join(tmp, 'go.mod'), 'module oracle\n\ngo 1.21\n');
  const env = { ...process.env, GOFLAGS: '' };
  const json = execFileSync('go', ['run', '.', path.resolve(repo)], { cwd: tmp, env, encoding: 'utf8', maxBuffer: 1 << 29 });
  const decls = JSON.parse(json);
  let parsed = 0, agreed = 0;
  /** @type {string[]} */
  const bad = [];
  for (const d of decls) {
    if (parseGoDeclaration(d.text)) parsed++;
    const diff = compare(d);
    if (diff === null) agreed++;
    else bad.push(`${d.file}: ${d.text.split('\n')[0]}\n    ${diff}`);
  }
  console.log(`declarations: ${decls.length}\nparsed: ${parsed}\nagreed: ${agreed}\ndisagreements: ${bad.length}`);
  for (const b of bad.slice(0, 20)) console.log(`- ${b}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = bad.length === 0 ? 0 : 1;
}

main();
