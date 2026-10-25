// @ts-check
'use strict';
// Dev script, not part of `npm test`: checks parsePythonDeclaration and raisesOf against
// Python's own `ast` module. Usage: node test/py-signature-oracle.js <path-to-python-repo>
// A small Python program (standard library only: ast) is written to a temp directory and run
// with `python3 -I` from another temp directory, with the repo path as an argument; it only
// parses source text, never imports or runs the repo's code. For every def / async def in
// every .py file (not venv, .venv, site-packages, __pycache__, .tox, node_modules, .git, and
// not root build/ or dist/) it prints the declaration's text (first decorator to the end of
// the body), whether it is a method, async, decorators, parameters and the names it raises.
// Each is compared with what the JS parser reports. Annotation text is compared with all
// whitespace removed, because `ast` gives the source text as written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parsePythonDeclaration, raisesOf } = require('../src/languages/python/signature');

// Deadline for the Python child, so a hang cannot stall the script.
const CHILD_DEADLINE_MS = 120000;
const MAX_REPORTED = 20;

const PY_PROGRAM = String.raw`
import ast, io, json, os, re, sys, tokenize

SKIP_DIRS = {"venv", ".venv", "site-packages", "__pycache__", ".tox", "node_modules", ".git"}
NAME = re.compile(r"[^\W\d]\w*(?:\.[^\W\d]\w*)*")

def split_lines(src):
    return src.encode("utf-8").splitlines(keepends=True)

def seg(lines, l1, c1, l2, c2):
    # ast offsets are 1-based lines and UTF-8 byte columns
    if l1 == l2:
        return lines[l1 - 1][c1:c2].decode("utf-8")
    parts = [lines[l1 - 1][c1:]] + lines[l1:l2 - 1] + [lines[l2 - 1][:c2]]
    return b"".join(parts).decode("utf-8")

def node_text(lines, n):
    return seg(lines, n.lineno, n.col_offset, n.end_lineno, n.end_col_offset)

def no_comments(text):
    # source text without comments (annotations and decorators may contain them)
    toks = tokenize.generate_tokens(io.StringIO(text.strip()).readline)
    return "".join(t.string + " " for t in toks if t.type not in (tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT))

def decl_start(lines, fn):
    # position of the '@' of the first decorator, searching back from its expression
    d = fn.decorator_list[0]
    ln, col = d.lineno, d.col_offset
    while True:
        at = lines[ln - 1][:col].rfind(b"@")
        if at >= 0:
            return ln, at
        ln -= 1
        col = len(lines[ln - 1])

def raises_in(lines, nodes):
    out = []
    stack = list(nodes)
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(n, ast.Raise) and n.exc is not None:
            m = NAME.match(node_text(lines, n.exc).lstrip("( \t\r\n"))
            if m:
                out.append(m.group(0))
        stack.extend(ast.iter_child_nodes(n))
    return sorted(set(out))

def params_of(lines, a):
    out = []
    def ann(x):
        return None if x.annotation is None else no_comments(node_text(lines, x.annotation))
    pos = list(a.posonlyargs) + list(a.args)
    ndef = len(a.defaults)
    for i, x in enumerate(pos):
        has_default = i >= len(pos) - ndef
        out.append({"name": x.arg, "kind": "posonly" if i < len(a.posonlyargs) else "arg", "ann": ann(x), "optional": has_default})
    if a.vararg:
        out.append({"name": a.vararg.arg, "kind": "vararg", "ann": ann(a.vararg), "optional": False})
    for x, d in zip(a.kwonlyargs, a.kw_defaults):
        out.append({"name": x.arg, "kind": "kwonly", "ann": ann(x), "optional": d is not None})
    if a.kwarg:
        out.append({"name": a.kwarg.arg, "kind": "kwarg", "ann": ann(a.kwarg), "optional": False})
    return out

def walk(path, rel, tree, lines, out):
    stack = [(tree, None)]
    while stack:
        node, parent = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.decorator_list:
                l1, c1 = decl_start(lines, node)
            else:
                l1, c1 = node.lineno, node.col_offset
            out.append({
                "file": rel, "line": node.lineno,
                "text": seg(lines, l1, c1, node.end_lineno, node.end_col_offset),
                "isMethod": isinstance(parent, ast.ClassDef),
                "async": isinstance(node, ast.AsyncFunctionDef),
                "decorators": [no_comments(node_text(lines, d)) for d in node.decorator_list],
                "params": params_of(lines, node.args),
                "returns": None if node.returns is None else no_comments(node_text(lines, node.returns)),
                "raises": raises_in(lines, node.body),
            })
        for c in ast.iter_child_nodes(node):
            stack.append((c, node))

def main():
    root = sys.argv[1]
    out, skipped = [], []
    for dp, dns, fns in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        dns[:] = sorted(d for d in dns if d not in SKIP_DIRS and not (rel_dir == "." and d in ("build", "dist")))
        for f in sorted(fns):
            if not f.endswith(".py"):
                continue
            p = os.path.join(dp, f)
            try:
                with open(p, "rb") as fh:
                    raw = fh.read()
                src = raw.decode("utf-8")
                tree = ast.parse(src)
            except Exception:
                skipped.append(os.path.relpath(p, root))
                continue
            walk(p, os.path.relpath(p, root), tree, split_lines(src), out)
    json.dump({"decls": out, "skipped": skipped}, sys.stdout)

main()
`;

/** Whitespace removed, and a trailing comma before a closing bracket (the parser drops it). @param {string} t */
const squash = (t) => t.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');

/** @param {any} d @returns {string[]} the decorators' names for binding, per the brief */
function expectedBinding(d) {
  const names = d.decorators.map(squash);
  for (const n of names) {
    if (n === 'staticmethod') return ['staticmethod'];
    if (n === 'classmethod') return ['classmethod'];
    if (n === 'property' || n === 'functools.cached_property' || n === 'cached_property' || /\.(setter|getter|deleter)$/.test(n)) return ['property'];
  }
  return ['function'];
}

/**
 * What the parser should report for an oracle declaration.
 * @param {any} d
 * @returns {{ params: { name: string, type: string, optional: boolean, rest: boolean }[], returns: string|null }}
 */
function expected(d) {
  /** @type {Record<string, string>} */
  const marker = { posonly: 'positional-only', arg: '', vararg: '*', kwonly: 'keyword-only', kwarg: '**' };
  let params = d.params.map((/** @type {any} */ p) => ({
    name: p.name,
    type: squash(`${marker[p.kind]}${p.ann || ''}`),
    optional: p.optional,
    rest: p.kind === 'vararg' || p.kind === 'kwarg',
  }));
  const dropFirst = d.isMethod && expectedBinding(d)[0] !== 'staticmethod' && params.length > 0 && !params[0].rest;
  if (dropFirst) params = params.slice(1);
  return { params, returns: d.returns === null ? null : squash(d.returns) };
}

/** @param {any} d @returns {string | null} a description of the first difference, or null */
function compare(d) {
  const parsed = parsePythonDeclaration(d.text, { isMethod: d.isMethod });
  if (!parsed) return 'parsePythonDeclaration returned null';
  const want = expected(d);
  const got = parsed.sig;
  if (got.async !== d.async) return `async ${got.async} != ${d.async}`;
  if (got.params.length !== want.params.length) {
    return `param count ${got.params.length} != ${want.params.length}: got [${got.params.map((p) => `${p.name}:${p.type}`)}] want [${want.params.map((p) => `${p.name}:${p.type}`)}]`;
  }
  for (let i = 0; i < want.params.length; i++) {
    const g = got.params[i];
    const w = want.params[i];
    if (g.name !== w.name) return `param ${i} name ${g.name} != ${w.name}`;
    if (squash(g.type || '') !== w.type) return `param ${i} (${w.name}) type ${g.type} != ${w.type}`;
    if (g.optional !== w.optional) return `param ${i} (${w.name}) optional ${g.optional} != ${w.optional}`;
    if (g.rest !== w.rest) return `param ${i} (${w.name}) rest ${g.rest} != ${w.rest}`;
  }
  if (got.returns === null ? want.returns !== null : squash(got.returns) !== want.returns) return `returns ${got.returns} != ${want.returns}`;
  if (parsed.decorators.map(squash).join('\n') !== d.decorators.map(squash).join('\n')) return `decorators [${parsed.decorators}] != [${d.decorators}]`;
  if (parsed.binding !== expectedBinding(d)[0]) return `binding ${parsed.binding} != ${expectedBinding(d)[0]}`;
  if (d.text[parsed.headerEnd - 1] !== ':') return `headerEnd ${parsed.headerEnd} is not just past a ':'`;
  const raises = [...raisesOf(d.text, parsed.headerEnd)].sort();
  if (raises.join(',') !== d.raises.join(',')) return `raises [${raises}] != [${d.raises}]`;
  return null;
}

function main() {
  const repo = process.argv[2];
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: node test/py-signature-oracle.js <path-to-python-repo>');
    process.exit(2);
  }
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-py-oracle-script-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-py-oracle-cwd-'));
  const script = path.join(scriptDir, 'oracle.py');
  fs.writeFileSync(script, PY_PROGRAM);
  let decls;
  let skipped;
  try {
    const json = execFileSync('python3', ['-I', script, path.resolve(repo)], {
      cwd: workDir, encoding: 'utf8', maxBuffer: 1 << 30, timeout: CHILD_DEADLINE_MS,
    });
    ({ decls, skipped } = JSON.parse(json));
  } finally {
    fs.rmSync(scriptDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  let agreed = 0;
  let unreadable = 0;
  /** @type {string[]} */
  const bad = [];
  for (const d of decls) {
    const diff = compare(d);
    if (diff === null) agreed++;
    else {
      if (diff.startsWith('parsePythonDeclaration returned null')) unreadable++;
      bad.push(`${d.file}:${d.line}: ${d.text.split('\n')[0]}\n    ${diff}`);
    }
  }
  console.log(`files skipped (not parseable by ast): ${skipped.length}`);
  for (const s of skipped.slice(0, MAX_REPORTED)) console.log(`  ${s}`);
  console.log(`unreadable declarations: ${unreadable}`);
  console.log(`agree ${agreed} of ${decls.length}`);
  for (const b of bad.slice(0, MAX_REPORTED)) console.log(`- ${b}`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

main();
