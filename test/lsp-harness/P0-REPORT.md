# P0 report: what Pyright gives us

Measured with

    node test/lsp-harness/p0-spike.js /Users/salah/Projects/impact-tree-test-repos/httpx

on encode/httpx at `b5addb64f0161ff6bfe94c124ef76f6a1fba5254` (2026-02-23). Machine: Intel Mac
(i7-9750H, 12 threads, 16 GiB, Darwin 25.6), `pyright` npm package 1.1.414
(`pyright-langserver --stdio`, installed per P-D1 in `~/Projects/impact-tree-scratchpad/py-tools`),
node 22.16.0, Python 3.12.8 (used only for `ast`/`tokenize`, isolated with `-I`). Final run:
exit 0, 55.9 s wall. The clone's code was never run. Cursor Pyright and Pylance were not run;
what the editor forwards is not measured here.

**Environment note.** This machine's `python3` (pyenv) already has httpcore, anyio, click, rich
and pygments installed, so by default Pyright resolved them (only `h2`, `socksio` unresolved). A
second run with `--python <bare venv>` (`python3 -m venv --without-pip`, sent as
`python.pythonPath`) made httpcore, click, rich, pygments, socksio unresolved (9 diagnostics in
`_main.py`, as expected). Sections 3–5 gave **identical callers and counts** in both runs
(diff with timings stripped: only the order of two callers differed). The probed calls do not
pass through third-party types; a call on a value returned by httpcore would become `Unknown`
and would land in the "unresolved" bucket of section 5.

## 1. documentSymbol (checked against `ast`, every FunctionDef/AsyncFunctionDef)

| file | ast defs | matched symbol (def line + name) | not listed |
| --- | --- | --- | --- |
| `httpx/_client.py` | 81 | 74 | 7 `@property` getters that have a setter |
| `httpx/_models.py` | 95 | 91 | 4 `@property` getters that have a setter |
| `httpx/_auth.py` | 19 | 19 | — (1 nested def) |
| `httpx/_status_codes.py` | 9 | 9 | — (7 `@classmethod`) |
| scratch module (written by the spike) | 17 | 15 | 2 `@typing.overload` signatures |

- Hierarchical `DocumentSymbol`s. Kinds: module function `Function`; method, `@classmethod`,
  `@staticmethod`, `@property` and setter all `Method` (no `Property` kind); class `Class`.
- Methods are children of their class: parent = enclosing class/def for 208/208 matched defs.
- Nested `def` inside a function: listed, as a `Function` child of its parent
  (`_auth.py` `digest` inside a method; scratch `Tool.outer` → `Function:inner`).
- **Parameters and locals are listed too**, as `Variable`/`Constant` children of every function
  (419 in `_client.py`, 215 in `_models.py`). Symbol collection must filter by kind.
- `range`: starts at the **first decorator** for decorated defs (11/11, 22/22, 7/7, 3/3) and at
  `def` otherwise; ends at ast `end_lineno` for all matched defs; the docstring is inside (it is
  the body's first statement; 92/92 docstrings inside). Comments above the decorators are outside.
- `selectionRange` is exactly the bare name (208/208).
- `detail` is always empty (`""` on every def in all five files): no signature from the server.
- **Same name twice — one symbol only.** A `@property` getter + `@x.setter` pair is one `Method`
  symbol whose `selectionRange` and `range` are the **setter's** (e.g. `BaseClient.timeout`: getter
  `def` at 254, symbol at 258, range 257–259). The getter's lines are inside no function symbol.
  `@overload` stubs + implementation: one symbol, the implementation (scratch `Tool.get`: overloads
  at 52/54, symbol at 55, range 55–56). No name is listed twice in any file.

## 2. Base side (`httpx/_client.py` at `15e21e9^` = 0.28.0, 81 ast defs, text differs from head)

| variant | result | first time | second time (after didClose, reopened) |
| --- | --- | --- | --- |
| (a) `impacttree-base:/httpx/_client.py?ref=…` | 535 symbols, 74 defs, 74/81 matched (same 7 merged getters as head) | 2.31 s | 619 ms |
| (b) `untitled:Untitled-1` | same | 518 ms | 508 ms |
| (c) temp file in `os.tmpdir()` (outside the workspace) | same | 568 ms | 496 ms |

All three are answered correctly, and `prepareCallHierarchy` works on each (1–4 ms). (a)'s
2.3 s is an order effect: it is the first document outside the workspace (its second time is
619 ms). Pyright, unlike gopls, accepts non-`file:` URIs. **G2's temp-copy approach works
unchanged.** Not checked: whether Cursor Pyright / Pylance register their document-symbol
provider for a custom scheme in the editor; the temp file avoids the question.

## 3. Call hierarchy (`prepareCallHierarchy` + `incomingCalls`)

| target | callers | distinct sites | in `tests/` | references |
| --- | --- | --- | --- | --- |
| module function `httpx._api.request` | 7 (`get`, `options`, … in `_api.py`) | 7 | 0 | 9 |
| module function `httpx._api.get` (called as `httpx.get`, re-export) | 5 | 6 | 5 | 8 |
| `self._merge_url` (`BaseClient._merge_url`) | 1 | 1 | 0 | 1 |
| `Response.raise_for_status` (annotated / inferred receivers) | 4 | 11 | 3 | 11 |
| scratch `Tool.duck`: `t: Tool` / untyped `anything` / `Other().duck()` | 1 (`t.duck()` only) | 1 | — | 1 |
| scratch `Other.duck` | 1 (`Other().duck()`) | 1 | — | 1 |
| `@property` `Response.encoding` (getter and setter give the same answer) | 21 | 25, all attribute uses (no `(`) | 18 | 27 |
| `@property` `BaseClient.timeout` | 3 | 10, all attribute uses | 1 | 12 |
| `@classmethod` `codes.get_reason_phrase` | 4 | 4 | 2 | 4 |
| scratch `@staticmethod Tool.make` / `@classmethod Tool.build` (via `cls.make()`) | 2 / 1 | 2 / 1 | — | 2 / 1 |
| scratch `@overload Tool.get` (at an overload or at the implementation) | 1 | 1 | — | 3 |
| scratch nested `Tool.outer.inner` | 1 (`outer`) | 1 | — | 1 |

- Callers in `tests/` are listed (only the URI tells them apart); re-exports (`httpx.get`) resolve.
- Untyped receiver: `anything.duck()` is **not** listed, for either `Tool.duck` or `Other.duck`,
  and no error or marker says so. Typed receivers are resolved to the right class.
- Method calls come back with **duplicated `fromRanges`** (22 for 11 sites on
  `raise_for_status`, 2 for 1 on `_merge_url`); plain function calls do not. Deduplicate.
- Property reads and writes are listed as callers (attribute uses, no `(`).

## 4. Value uses

| function | used as | incomingCalls | references |
| --- | --- | --- | --- |
| `_main.validate_json` | click `callback=validate_json` | `null` | 1 |
| `_main.trace` | `functools.partial(trace, …)` inside a dict | `null` | 1 |
| scratch `stored_in_dict` | `HANDLERS = {"a": fn}` | `null` | 1 |
| scratch `passed_as_callback` | `map(fn, …)` | `null` | 1 |
| scratch `register` | applied only as `@register` | `null` | 1 |
| scratch `registered_handler` | decorated by `@register`, never named again | `null` | 0 |

Unlike gopls, **Pyright's call hierarchy does not list value uses** (nor decorator application);
`references` does. Pyright answers `null` (not `[]`) when there are no incoming calls. So G4's
"value use" handling cannot be reused as is: for Python, a value use is visible only via
`references` (a reference not at a listed call site), and a function reached only through a
registry (`registered_handler`) has no reference at all.

## 5. Duck typing (P-D4): call hierarchy vs text search for `.<name>(` in all 61 `.py` files (+ scratch)

Every text hit not at a listed site was classified: inside a string/comment (Python `tokenize`),
or by `textDocument/definition` at the name: resolves to another definition (unrelated), or
resolves to nothing (unresolved).

| method | text hits | listed by server | string/comment | other definition | unresolved code hits (hand-checked) |
| --- | --- | --- | --- | --- | --- |
| `Response.raise_for_status` | 17 | 11 | 3 | 0 | 3: **2 real misses** (`tests/client/test_event_hooks.py:53,105`, hooks `def raise_on_4xx_5xx(response)`, untyped param) + the planted scratch one |
| `Headers.multi_items` | 8 | 4 | 1 | 3 (`QueryParams.multi_items`) | 0 |
| `Response.read` | 48 | 16 | 2 | 26 (`Request.read`, file `read`, `typing.IO`) | 4, **all unrelated** (`self._stream.read` file-like ×2, `pickle.loads(...)` Request, WSGI `environ["wsgi.input"].read()`) |
| `Client.send` | 35 | 6 | 6 | 23 (generator `.send`, `AsyncClient.send`) | 0 |

No hit resolved to the target without being listed, and every listed site was a text hit.
Real calls of `raise_for_status` in the repo: 13; the server found 11 (2 missed, 15%). The other
three methods: no real misses found.

- P-D4 (B) **as written** (text hits outside listed sites) would flag all four methods
  (6, 4, 32, 29 hits): three false alarms, and the counts are mostly unrelated names.
- Dropping string/comment hits and hits the server resolves to another definition leaves only
  "unresolved" hits: it flags `raise_for_status` (correct, 2 real) and `read` (4 false). 1 of 4
  methods is a false alarm instead of 3 of 4, and the count shown is small and honest.

## 6. Timings

| step | time |
| --- | --- |
| spawn + initialize | 311 ms |
| first documentSymbol (`_client.py`) after initialize | 2.60 s (2.1–4.2 s over 5 other runs; 0.77 s once) |
| first prepareCallHierarchy / incomingCalls (cold) | 468 ms / 373 ms (332–915 ms over runs) |
| warm prepareCallHierarchy, n=10 | median 2 ms, max 80 ms |
| warm incomingCalls, n=10 | median 45 ms, max 105 ms |
| warm references, n=10 | median 25 ms, max 136 ms |
| documentSymbol on first open of 10 other files | median 13 ms, max 56 ms |

Some first queries on a name take ~1–2 s (`_api.get` incomingCalls 1.7–2.6 s; `Tool.get` 1.1 s):
Pyright checks every file that contains the name text. The 30 s per-request deadline is far above
all of these. The whole spike, including ~110 `definition` queries, ran in ~56 s (definition was
not timed separately).

## What this means for later tasks

- **P2 (symbols):** filter children by kind (functions list their parameters and locals). Property
  getters with a setter and `@overload` stubs are **not** in the symbols, and their lines are inside
  no function symbol: P2 needs a text scan of the class body for `def` headers (or the getter's
  change is attributed to the class / missed). Repeats `#2` will not come from the server.
  `range` includes decorators, so a decorator change is inside the function.
- **P3 (signatures):** `detail` is empty; the header must be parsed from the text, as planned.
- **P4 (callers):** deduplicate `fromRanges`; treat Pyright's `null` from incomingCalls as "no
  calls" only after checking what the editor command returns for it; value uses need `references`
  (the call hierarchy never lists them); property accesses are listed as callers without `(`.
  Duck-typing evidence: filter text hits by strings/comments and by `definition` (see section 5).
- **P-D5:** nested defs are available as children, so either choice is possible; keeping them in
  the parent's body (skip `Function` children of functions) matches Go and the measured shape.
