# P7 report: the Python pipeline against encode/httpx, checked by ast and Jedi

Reproduce with

```
node test/lsp-harness/py-verify.js /Users/salah/Projects/impact-tree-test-repos/httpx \
  --worktree /Users/salah/Projects/impact-tree-test-repos/httpx-pr
```

(see the script's header for the flags; the corpus is `py-verify-corpus.json`). Every number
below is from that script; the tables are its `summary.md`.

## Revision, configuration, environment

- **Impact Tree:** branch `feat/python-p0` from `da25eab` (P5/P6) plus the P7 commits; the
  numbers are for the tree with the two fixes below ("after"), with "before" where a fix
  changed them.
- **Target:** encode/httpx clone (detached at `b5addb6`, untouched: the oracles read it through
  `git archive` / `git show`). The pipeline runs in the worktree `httpx-pr`, checked out at
  each PR's head (detached) and put back on `pr-1600` afterwards. `pr` mode against the base
  commit (`allowLocalBase`); every PR is a squash commit, so base = its parent and the diff is
  exactly the PR's.
- **Pipeline options:** the editor's: `skipForest: true`, `deferTestReach: true`, depth 2. The
  Python provider, the harness's Pyright services (`pyright-services.js`, base sides through a
  temporary file), the harness resolver with `pythonProvider.editorCallers(...)`
  (`harness-languages.js`). Cursor Pyright / Pylance were not run.
- **Oracles:** (a) an `ast` program (Python 3.12.8 standard library, `python3 -I`, written to a
  temporary directory and run from another); (b) **Jedi 0.20.1** (parso 0.8.7) in the
  scratchpad virtualenv `py-tools/venv` (Python 3.12.8), run the same way.
- **Machine:** Intel Core i7-9750H (6 cores / 12 threads), 16 GiB, macOS 26.6.2, Node 22.16.0,
  pyright 1.1.414. Other applications were running; times are indicative.

## How no httpx code ran

Nothing of httpx is imported or executed. The `ast` program only parses text. Jedi reads files
with parso; it imports a module only to inspect a compiled extension or a name in
`settings.auto_import_modules`. The script (1) checks that the PR's head tree has no `.so`,
`.pyd` or `.dylib` (none in any of the 10), (2) empties `auto_import_modules` (default
`['gi']`), (3) uses `jedi.InterpreterEnvironment()` (no subprocess) and
`Project(load_unsafe_extensions=False)`, and (4) checks afterwards, in the same process, that no
module in `sys.modules` has a file under the export, that `sys.path` is unchanged and that the
export is not on it; any of these failing fails the PR's oracle. All 10 PRs recorded
`modulesFromExport: []`, `sysPathUnchanged: true`, `exportOnSysPath: false` (`jediCheck` in each
`<n>.json`). The virtualenv has only Jedi and parso (httpx and its dependencies are not
installed). Both programs run with `-I` from an empty temporary directory.

## Corpus

| PR | head | base | Python files (httpx/) | why |
| --- | --- | --- | --- | --- |
| #3319 | 8e36f2bc6 | 3f76571d3 | 21 (14) | properties, async, decorators, dunders and removals (new `SSLContext` API) |
| #3394 | 1805ee0d2 | 41597adff | 8 (7) | renames, a property and dunders (0.28 upgrade path) |
| #3389 | 7b19cd5f4 | b47d94c90 | 4 (2) | functions moved across files (`_utils.py` → `_client.py`), with a raise |
| #3382 | 83a85189c | 662255397 | 2 (2) | functions moved across files (`_utils.py` → `_models.py`), with a raise |
| #3245 | 359f77d4f | b351a44fb | 5 (5) | signature changes (URL constructor) |
| #3371 | d293374b6 | 489fef48b | 2 (1) | signature changes (percent-escaping sets) |
| #3250 | 7c0cda153 | beb501fc2 | 2 (1) | raises (`InvalidURL` messages) |
| #3377 | e9cabc8e1 | eeb5e3c2a | 6 (4) | imports moved into functions |
| #1577 | 8fd5b7101 | ed1999574 | 4 (3) | async and `contextmanager` decorators |
| #1336 | 4b8774041 | 65b69fabd | 1 (1) | dunders, async, classmethod (covariant `__enter__`) |

## What is compared

- **Changed functions:** rows `(path, key, changed|added|removed)` in non-test `httpx/` files,
  against the `ast` oracle's module functions and class methods (nested classes too, through
  `if`/`try`/`with`/`for`/`while` blocks, never into a function: P-D5) whose text from the
  first decorator to the body's end differs, or exist on one side only; keys `Class.method`,
  repeats `#2` in source order. Pipeline rows outside that scope (tests) are counted, not
  compared.
- **Kinds:** for every change both see, from `ast`'s parameters (`self`/`cls` dropped unless
  static; name, kind, annotation without white space, default or not), returns, `async`,
  binding (property / static / class method) and raised names: a binding change requires
  `type-changed`, more parameters `required-param|optional-param`, fewer `param-removed`,
  otherwise any parameter kind; a return change `return-changed`; `async` `async-changed`; a
  new raised name `new-throw`; nothing else allows only `body`, and no kind may appear that no
  difference justifies.
- **Callers:** per changed or added function, the set of functions enclosing a call site in
  the head commit (the `ast` index; outside every function, `(module)`). Jedi's are its
  `get_references` at the def's name that are calls (followed by `(`; for a property, an
  attribute access); for `__init__` also its class's name followed by `(`. False positives
  (we list, Jedi does not) and misses (Jedi lists, we do not) are counted separately.
- **"May be missing":** every Jedi caller we miss must sit on a change whose answer is
  incomplete (`callersComplete: false`).
- **Fine:** no change with a caller-visible kind may be drawn without colour
  (`toneOf(classifyChangeVerdict(c)) === null`) while Jedi finds a non-test caller whose call
  line the PR did not touch.

## Results (after the fixes)

| PR | Python files (httpx/) | functions (oracle) | precision | recall | header changes right | new raises right | body-only right | callers ours / Jedi | caller precision | caller recall | Jedi-missed on incomplete | fine with non-updated Jedi caller | Pyright start / first / full |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #3319 | 21 (14) | 51 | 100% | 100% | 21/21 | 0/0 | 11/11 | 50 / 276 | 94.0% | 17.0% | 7/7 | 0 | 0.4 / 4.5 / 9.4 s |
| #3394 | 8 (7) | 23 | 100% | 100% | 18/18 | 0/0 | 1/1 | 38 / 248 | 100.0% | 15.3% | 4/4 | 0 | 0.3 / 4.8 / 7.5 s |
| #3389 | 4 (2) | 7 | 100% | 100% | 0/0 | 0/0 | 1/1 | 10 / 10 | 100.0% | 100.0% | 0/0 | 0 | 0.3 / 3.9 / 4.4 s |
| #3382 | 2 (2) | 5 | 100% | 100% | 0/0 | 0/0 | 1/1 | 2 / 33 | 100.0% | 6.1% | 1/1 | 0 | 0.3 / 3.1 / 3.7 s |
| #3245 | 5 (5) | 35 | 100% | 100% | 35/35 | 0/0 | 0/0 | 229 / 353 | 59.0% | 38.2% | 3/3 | 0 | 0.3 / 4.2 / 13.0 s |
| #3371 | 2 (1) | 1 | 100% | 100% | 0/0 | 0/0 | 1/1 | 3 / 3 | 100.0% | 100.0% | 0/0 | 0 | 0.3 / 2.2 / 2.7 s |
| #3250 | 2 (1) | 1 | 100% | 100% | 0/0 | 0/0 | 1/1 | 3 / 3 | 100.0% | 100.0% | 0/0 | 0 | 0.3 / 2.4 / 2.8 s |
| #3377 | 6 (4) | 7 | 100% | 100% | 0/0 | 0/0 | 6/6 | 7 / 33 | 100.0% | 21.2% | 3/3 | 0 | 0.3 / 2.0 / 4.2 s |
| #1577 | 4 (3) | 9 | 100% | 100% | 1/1 | 0/0 | 0/0 | 10 / 9 | 90.0% | 100.0% | 0/0 | 0 | 0.3 / 4.1 / 5.0 s |
| #1336 | 1 (1) | 2 | 100% | 100% | 2/2 | 0/0 | 0/0 | 0 / 0 | n/a | n/a | 0/0 | 0 | 0.3 / 3.7 / 4.1 s |
| **total** | | **141** | **100%** | **100%** | **77/77** | **0/0** | **22/22** | **352 / 968** | **72.2%** | **26.2%** | **18/18** | **0** | |

Against the targets: changed-function detection 100% precision (target 100%) and 100% recall
(target ≥ 98%; 99.3% before fix F2); every header change has the right kind (77/77) and every
body-only change is `body` (22/22); callers: precision 72.2% and recall 26.2% against Jedi, with
the 98 false positives and 714 misses explained below (all 98 are real calls Jedi cannot type;
all 714 are constructions of a changed `__init__`); every one of the 18 changes with a Jedi
caller we miss is incomplete; none is drawn as fine while Jedi has a non-updated caller.

**Not covered by this corpus:** a `new-throw`. No change in the 10 PRs adds a raised name to
an existing function (#3250 changes `raise InvalidURL("…")` to `raise InvalidURL(error)`: the
same name; the "with a raise" functions of #3389/#3382 are moves, i.e. added functions, which
have no kinds). `new-throw` is covered by P3's unit tests and the signature oracle only.

Of 112 changes with callers compared, the incomplete answers: `referenced-as-value` 30, the
constructor reason (F1) 20, "no incoming-call result" 6, protocol 4, registration 2, duck typing
2 (`Client.get`: "more than 50 calls by this name; 63 not checked"; `AsyncClient.get` and
`URL.join`: 1 unresolved call by this name).

### Before the fixes

| metric | before | after |
| --- | --- | --- |
| function recall | 99.3% (`_compat.py#set_minimum_tls_version_1_2#2` removed, not reported: F2) | 100% |
| `__init__` answers | 20 "no incoming-call result" in the harness; in the editor, where `null` may become `[]`, the constructor path's complete "no callers" (F1) | 20 incomplete, constructor reason |

## Disagreements and defects

### Fixed

- **F1. Constructions were not callers of `__init__`, and could read complete**
  (`src/languages/python/editor-extras.js`). Pyright answers `null` to `incomingCalls` at
  `__init__` and lists the `Cls(...)` constructions only at the class name (measured: `Proxy`
  class 5 incoming calls, 18 references; `Proxy.__init__` `null`, 0 references). The P4 extras
  assumed the constructor path covered it. In the harness every changed `__init__` read "no
  incoming-call result" (incomplete, but for the wrong reason: 714 Jedi constructions, e.g. 136
  of `Client` in #3245); in the editor, if VS Code turns `null` into `[]`, the extras found no
  value use or stray hit and the shared constructor path returned a complete `di` "no callers".
  Now a class's `__init__` is always incomplete with "a constructor: its constructions
  (`Class(...)`) are not listed, so its callers cannot be traced", from `explainIncomplete`
  (`null`) and `moreCallers` (`[]`, or explicit `super().__init__()` callers, which are kept).
  Regression test: `__init__ is always incomplete: constructions are not listed as its callers`
  (test/python-editor-extras.test.js; failed before: `di`, complete). Listing the constructions
  (asking at the class name) is a follow-up.
- **F2. A function defined in both branches of an `if` lost its second definition**
  (`src/languages/python/provider.js`). httpx `_compat.py` (base of #3319) defines
  `set_minimum_tls_version_1_2` under `if sys.version_info >= …:` and again under `else:`;
  Pyright lists one. The P2 recovery only scanned defs at the scope's own indentation, so the
  second was missing and its removal was not reported (and a change in it would have read as
  outside every function). Now a deeper def line that no symbol covers is recovered when the
  nearest less-indented code line above it is an `if`/`elif`/`else`/`try`/`except`/`finally`/
  `with`/`for`/`while` opener (`inBlockOfScope`), at module level and in class bodies; a
  recovered def covers its own body (a def nested in it stays its body). Regression test:
  `a name defined in both branches of an if or try is recovered, at module level and in a
  class; nested defs and docstrings are not` (test/python-symbols.test.js, new fixture
  `branches.py` recorded from pyright 1.1.414; failed before).

### Oracle artefacts (not changed in the engine)

- **A1. Jedi does not type a `with … as x` target** (all 98 false positives, 103 call sites).
  httpx's `Client.__enter__` is `def __enter__(self: T) -> T`; Jedi does not infer `x` in
  `with httpx.Client(...) as x:`, so `x.get(...)` has no references in Jedi, while Pyright
  resolves it. Every one of the 103 sites was checked by script: its receiver is bound by a
  `with … as <receiver>` statement above it (93 on the same logical line, 10 in a multi-line
  `with Client(\n … \n) as client:` read by hand: `_api.py:110/118/172`, `_main.py:483`,
  `tests/client/test_event_hooks.py:30/61/81/113/138/195`). Jedi does find the same methods'
  calls on a receiver assigned with `=` (the 352 − 98 = 254 shared callers). Samples 1–12 below.
- **A2. `__init__` constructions** (all 714 misses): real calls, now on answers marked
  incomplete (F1); they stay misses until the follow-up lists them.

## The 30 hand-checked callers

Read in the head commit with `git show <head>:<file> | sed -n …` and `git grep`.

| # | PR | callee | caller at | kind of answer | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | #3245 | `Client.request` | `httpx/_api.py:118` `request` | ours only, complete | real: `with Client(...) as client: return client.request(` (A1) |
| 2 | #3245 | `Client.stream` | `httpx/_api.py:172` `stream` | ours only, complete | real: `with client.stream(` inside `with Client(` (A1) |
| 3 | #3245 | `Client.stream` | `httpx/_main.py:483` `main` | ours only, complete | real: `with client.stream(` on a `with Client(...) as client` (A1) |
| 4 | #3245 | `AsyncClient.get` | `tests/test_asgi.py:97` `test_asgi` | ours only, incomplete (duck) | real: `async with httpx.AsyncClient(...) as client:` then `await client.get(` (A1) |
| 5 | #3245 | `Client.get` | `tests/client/test_auth.py:248` | ours only, incomplete (duck) | real: `with httpx.Client(...) as client: client.get(url)` (A1) |
| 6 | #3245 | `BaseClient.build_request` | `tests/client/test_client.py:52` `test_build_request` | ours only, complete | real: `client.build_request("GET", url)` on a `with` target (A1) |
| 7 | #3245 | `Client.options` | `tests/client/test_client.py:151` | ours only, complete | real: `client.options(server.url)` (A1) |
| 8 | #3245 | `Client.put` | `tests/client/test_client.py:165` | ours only, complete | real: `client.put(server.url, content=…)` (A1) |
| 9 | #3245 | `AsyncClient.post` | `tests/client/test_async_client.py:58` | ours only, complete | real: `await client.post(url, …)` (A1) |
| 10 | #3319 | `AsyncClient.request` | `tests/client/test_async_client.py:118` | ours only, complete | real: `await client.request(` (A1) |
| 11 | #1577 | `AsyncClient.stream` | `tests/client/test_async_client.py:82` `test_access_content_stream_response` | ours only, complete | real: `async with httpx.AsyncClient() as client: async with client.stream(` (A1) |
| 12 | #3245 | `Client.get` | `tests/client/test_event_hooks.py:30` | ours only, incomplete (duck) | real: `with httpx.Client(\n …\n) as http: http.get(` (A1) |
| 13 | #3389 | `_is_https_redirect` | `httpx/_client.py:552` `BaseClient._redirect_headers` | both, complete | real: `if not _is_https_redirect(request.url, url):` |
| 14 | #3389 | `_port_or_default` | `httpx/_client.py:70,72` `_is_https_redirect`, `:89` `_same_origin` | both, complete | real, 2 callers |
| 15 | #3382 | `_normalize_header_key` | `httpx/_models.py:91,96` `Headers.__init__` | both, complete | real |
| 16 | #3377 | `_load_httpcore_exceptions` | `httpx/_transports/default.py:99` `map_httpcore_exceptions` | both, complete | real (the import moved into a function) |
| 17 | #3371 | `urlparse` | `httpx/_urls.py:117` `URL.__init__` | both, complete | real; also `_urlparse.py:197` and `tests/models/test_whatwg.py:30` (3 = 3) |
| 18 | #3319 | `BaseClient._get_proxy_map` | `httpx/_client.py:659` `Client.__init__`, `:1381` `AsyncClient.__init__` | both, complete | real, typed `self` |
| 19 | #3245 | `BaseClient._merge_url` | `httpx/_client.py:346` `BaseClient.build_request` | both, complete | real |
| 20 | #3394 | `Client._init_transport` | `httpx/_client.py:661` `Client.__init__` | both, complete | real (`AsyncClient`'s own at `:1362` is its own method) |
| 21 | #3245 | `Client.__init__` | `httpx/_api.py:109` `request` | Jedi only, incomplete (constructor) | real construction `with Client(`; missed, marked incomplete (F1) |
| 22 | #3382 | `Headers.__init__` | `httpx/_client.py:180` `BaseClient.__init__` | Jedi only, incomplete (constructor) | real: `self.headers = Headers(headers)` |
| 23 | #3245 | `Proxy.__init__` | `httpx/_client.py:219` `BaseClient._get_proxy_map` | Jedi only, incomplete (constructor) | real: `Proxy(url=url)` |
| 24 | #3319 | `SSLContext.__init__` | `httpx/_config.py:34` `create_ssl_context` | Jedi only, incomplete (constructor) | real: `SSLContext(verify=verify)` |
| 25 | #3319 | `BoundSyncStream.__init__` | `httpx/_client.py:999` `Client.send` | Jedi only, incomplete (constructor) | real: `response.stream = BoundSyncStream(` |
| 26 | #3245 | `BaseClient.__init__` | 2 `super().__init__(` in `Client`/`AsyncClient.__init__` | both, incomplete (constructor) | real explicit calls, kept; constructions of subclasses not listed, so incomplete is right |
| 27 | #1336 | `Client.__enter__` | none by name; `with Client(` at `httpx/_api.py:90` | neither, incomplete (protocol) | real implicit call through `with`; protocol reason right |
| 28 | #3319 | `SSLContext.__repr__` | none | neither, incomplete (protocol) | called by `repr()` only; protocol reason right |
| 29 | #3319 | `BoundSyncStream.close` | `httpx/_models.py:904` `Response.close`: `self.stream.close()` | neither, incomplete (no incoming-call result) | real dynamic dispatch: `stream: SyncByteStream \| AsyncByteStream \| None`; neither tool can resolve it; incomplete is right |
| 30 | #3319 | `BoundAsyncStream.aclose` | `httpx/_models.py:1008` `Response.aclose`: `await self.stream.aclose()` | neither, incomplete (no incoming-call result) | as 29 |

All 30 verdicts agree with our answer: every caller we list is a real call, and each caller we
do not list is on an answer marked incomplete with a reason that names why.

## Running it

| run | what | wall |
| --- | --- | --- |
| 1 | uncached oracles (cache emptied), before the fixes | 78 s |
| 2 | cached oracles, after the fixes (the tables above) | 59 s |
| 3 | `--no-cache`, after the fixes (results identical to run 2) | 75 s |

Within the budgets (uncached ≤ 5 min, cached ≤ 2 min); the run's deadline is 8 min. Oracles
alone: 1–46 s per PR (Jedi dominates: #3245's 39 targets 46 s), at most 3 PRs at once. Time to
first / full result with a fresh Pyright per PR: 2.0–4.8 s / 2.7–13.0 s (the full result waits
for the caller answers and their reference and duck-typing checks).

## Follow-ups

- List an `__init__`'s constructions by asking the call hierarchy at its class name (the
  answer stays incomplete for subclass constructions and factories). Needs either a provider
  hook for the query position or the extras asking it after a `null`; shared code, so not done
  here.
- `new-throw` on real PRs: none in this corpus; find a PR that adds a raise to an existing
  function if the owner wants it measured.
- The 6 "no incoming-call result" answers (`close`/`aclose`/`decode`/`handle_request`, `URL.raw`)
  are honest but generic; a better reason (dispatch through a base class or protocol) would
  read better.
