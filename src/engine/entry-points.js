// @ts-check
'use strict';
// Entry points: where a call path enters the application from outside it. An HTTP route,
// a CLI command, a `main`, an Electron IPC channel, a UI route, or the public API of a
// published library. Pure: every input is passed in, nothing is read here. The repository
// facts (package exports, `__all__`, cobra parents) come from ./entry-facts.js.
//
// Only framework-level patterns are recognised, from the text alone. What this does NOT
// see, so a path that stops at such a function reads `top-unidentified`, not "no entry":
// - a handler registered through a value the text does not name (a table of handlers, a
//   `case "x":` dispatch, a dependency-injection container, a plugin registry);
// - registrations in another file than the handler, unless the call site itself sits
//   inside the registration (`app.get('/x', (c) => handler(c))`);
// - frameworks not listed below.

/**
 * @typedef {'http'|'cli-command'|'main'|'dev-tool'|'public-api'|'ipc'|'ui-route'|'job'|'event'} EntryType
 *
 * One recognised entry point. `name` is what a reviewer reads: the route, the command line,
 * the exported name. `how` says which pattern matched, so an explanation can cite it.
 * @typedef {object} EntryInfo
 * @property {EntryType} type
 * @property {string} name
 * @property {string} [method] HTTP method, upper case, when known (`'ALL'` for any).
 * @property {string} [route] HTTP or UI route as written.
 * @property {string} how
 */

/**
 * Repository-level facts, gathered once per analysis (./entry-facts.js). Every field is
 * optional: a missing one means "not gathered", and only the patterns that need it are lost.
 * @typedef {object} EntryFacts
 * @property {Map<string, Set<string>|'*'>} [tsPublic] Repository-relative path of a source
 *   file reachable from a published package's entry points -> the names it exports to the
 *   package's users, or `'*'` for all its exports (reached through `export *` or as an entry).
 * @property {Map<string, Set<string>>} [pyPublic] Repository-relative path of a Python
 *   module -> names a top-level package exports from it (its `__all__`).
 * @property {Map<string, string>} [goCommandPrefix] `<dir>#<function>` of a function that
 *   builds a cobra command -> the parent command line (`'gh pr'`), when known.
 * @property {Map<string, string>} [binFiles] Repository-relative path of a package `bin`
 *   source file -> the command name.
 */

/** @typedef {'ts'|'go'|'python'} EntryLanguage */

/**
 * The language whose patterns apply to a file, or null when none are known (Java, others).
 * @param {string} file
 * @returns {EntryLanguage|null}
 */
function entryLanguageOf(file) {
  if (/\.(?:[cm]?[jt]sx?)$/.test(file) && !/\.d\.[cm]?ts$/.test(file)) return 'ts';
  if (/\.go$/.test(file)) return 'go';
  if (/\.pyi?$/.test(file)) return 'python';
  return null;
}

// Longest stretch of text scanned between a function's name and a call site in it. Unit:
// UTF-16 code units. A larger gap (a module-level call deep in a huge file) is not scanned,
// so a call-site registration there is not recognised: the path then ends unidentified.
const MAX_SCAN_CHARS = 200000;
// Enclosing brackets examined outward from a call site. Unit: brackets.
const MAX_ENCLOSING = 8;

const HTTP_VERBS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all'];

/**
 * The open brackets enclosing `offset`, innermost last, from a forward scan that starts at
 * `from`. Strings, template literals and comments are skipped (Python `#` and triple
 * quotes, Go raw strings included); a regular-expression literal is not recognised, which
 * can shift the result in rare JavaScript. Null when the gap is over MAX_SCAN_CHARS or the
 * offsets are out of order.
 * @param {string} text
 * @param {number} from
 * @param {number} offset
 * @param {EntryLanguage} language
 * @returns {Array<{ ch: string, at: number }>|null}
 */
function enclosingBrackets(text, from, offset, language) {
  if (!(from >= 0 && from <= offset && offset <= text.length) || offset - from > MAX_SCAN_CHARS) return null;
  /** @type {Array<{ ch: string, at: number }>} */
  const stack = [];
  let i = from;
  while (i < offset) {
    const ch = text[i];
    const next = text[i + 1];
    if (language !== 'python' && ch === '/' && next === '/') { i = lineEnd(text, i); continue; }
    if (language !== 'python' && ch === '/' && next === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? offset : e + 2; continue; }
    if (language === 'python' && ch === '#') { i = lineEnd(text, i); continue; }
    if (language === 'python' && (ch === '"' || ch === "'") && text.startsWith(ch.repeat(3), i)) {
      const e = text.indexOf(ch.repeat(3), i + 3); i = e === -1 ? offset : e + 3; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { i = stringEnd(text, i, ch, language); continue; }
    if (ch === '(' || ch === '{' || ch === '[') stack.push({ ch, at: i });
    else if (ch === ')' || ch === '}' || ch === ']') stack.pop();
    i++;
  }
  return stack;
}

/** @param {string} text @param {number} i @returns {number} */
function lineEnd(text, i) {
  const e = text.indexOf('\n', i);
  return e === -1 ? text.length : e;
}

/**
 * Index just past the string starting at `i`. A Go raw string (backquote) has no escapes; a
 * JavaScript template's `${}` parts are not parsed (a backquote inside one ends it early).
 * @param {string} text @param {number} i @param {string} quote @param {EntryLanguage} language
 * @returns {number}
 */
function stringEnd(text, i, quote, language) {
  const raw = language === 'go' && quote === '`';
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (!raw && c === '\\') { j += 2; continue; }
    if (c === quote) return j + 1;
    if (c === '\n' && quote !== '`') return j + 1;
    j++;
  }
  return text.length;
}

/**
 * The string literal that opens the argument list at `parenAt` (`('/users', …)`), or null.
 * @param {string} text @param {number} parenAt
 * @returns {string|null}
 */
function firstStringArg(text, parenAt) {
  const m = /^\(\s*(['"`])([^'"`\n]*)\1/.exec(text.slice(parenAt, parenAt + 400));
  return m ? m[2] : null;
}

/**
 * The text of the bracketed region opening at `at`, up to its matching close or `limit`
 * characters.
 * @param {string} text @param {number} at @param {EntryLanguage} language @param {number} [limit]
 * @returns {string}
 */
function bracketBody(text, at, language, limit = 20000) {
  const end = Math.min(text.length, at + limit);
  let depth = 0;
  let i = at;
  while (i < end) {
    const ch = text[i];
    if (language !== 'python' && ch === '/' && text[i + 1] === '/') { i = lineEnd(text, i); continue; }
    if (ch === '"' || ch === "'" || ch === '`') { i = stringEnd(text, i, ch, language); continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') { depth--; if (depth === 0) return text.slice(at, i + 1); }
    i++;
  }
  return text.slice(at, end);
}

// ---------------------------------------------------------------------------------------
// Call-site entries: the call to the walked function sits inside a registration.

/**
 * Whether the call at `callSiteStart` in a caller's text sits inside a framework
 * registration, which makes the caller an entry point for that path (`app.get('/x',
 * (c) => handler(c))`, a cobra command's `RunE`). `callerPos` is the caller's name offset:
 * the scan starts there (0 for module-level code).
 * @param {{ language: EntryLanguage, text: string, callerPos: number, callSiteStart: number,
 *   relPath: string, callerLabel: string, facts?: EntryFacts }} input
 * @returns {EntryInfo|null}
 */
function callSiteEntry({ language, text, callerPos, callSiteStart, relPath, callerLabel, facts }) {
  const stack = enclosingBrackets(text, callerPos, callSiteStart, language);
  if (!stack) return null;
  for (let k = stack.length - 1, seen = 0; k >= 0 && seen < MAX_ENCLOSING; k--, seen++) {
    const { ch, at } = stack[k];
    const before = text.slice(Math.max(0, at - 120), at);
    const hit = language === 'go'
      ? goRegistrationAt(text, at, ch, before, relPath, callerLabel, facts)
      : ch === '(' ? (language === 'ts' ? tsRegistrationAt(text, at, before) : null) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {string} text @param {number} at @param {string} before
 * @returns {EntryInfo|null}
 */
function tsRegistrationAt(text, at, before) {
  const route = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch|head|options|all|use|route)\s*$/.exec(before);
  if (route) {
    const path = firstStringArg(text, at);
    // A path argument separates a route from `map.get(key)`, `.use(middleware)` and the like.
    if (path !== null && path.startsWith('/')) {
      const method = route[2] === 'use' || route[2] === 'route' || route[2] === 'all' ? 'ALL' : route[2].toUpperCase();
      return { type: 'http', name: `${method} ${path}`, method, route: path, how: `${route[1]}.${route[2]}() registration` };
    }
  }
  const ipc = /\bipcMain\s*\.\s*(handle|handleOnce|on|once)\s*$/.exec(before);
  if (ipc) {
    const channel = firstStringArg(text, at);
    const named = channel ?? identifierArg(text, at);
    if (named) return { type: 'ipc', name: named, how: `ipcMain.${ipc[1]}() handler` };
  }
  return null;
}

/** @param {string} text @param {number} at @returns {string|null} */
function identifierArg(text, at) {
  const m = /^\(\s*([A-Za-z_$][\w$.]*)\s*,/.exec(text.slice(at, at + 200));
  return m ? m[1] : null;
}

/**
 * @param {string} text @param {number} at @param {string} ch @param {string} before
 * @param {string} relPath @param {string} callerLabel @param {EntryFacts|undefined} facts
 * @returns {EntryInfo|null}
 */
function goRegistrationAt(text, at, ch, before, relPath, callerLabel, facts) {
  if (ch === '{' && /(?<![*\w.])cobra\.Command$/.test(before)) {
    const cmd = cobraLiteral(bracketBody(text, at, 'go'));
    if (cmd && cmd.runs) return cobraEntry(cmd.use, relPath, simpleGoName(callerLabel), facts, 'call inside a cobra.Command literal');
    return null;
  }
  if (ch !== '(') return null;
  const reg = /\b([A-Za-z_]\w*)\s*\.\s*(HandleFunc|Handle|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|Head|Options)\s*$/.exec(before);
  if (!reg) return null;
  const pattern = firstStringArg(text, at);
  if (pattern === null) return null;
  return goHttpEntry(reg[1], reg[2], pattern);
}

/**
 * @param {string} receiver @param {string} call @param {string} pattern
 * @returns {EntryInfo|null}
 */
function goHttpEntry(receiver, call, pattern) {
  if (call === 'Handle' || call === 'HandleFunc') {
    // Go 1.22 patterns may carry the method: "GET /items/{id}".
    const m = /^([A-Z]+)\s+(\/.*)$/.exec(pattern);
    const method = m ? m[1] : 'ALL';
    const route = m ? m[2] : pattern;
    if (!route.startsWith('/')) return null;
    return { type: 'http', name: `${method} ${route}`, method, route, how: `${receiver}.${call}() registration` };
  }
  if (!pattern.startsWith('/')) return null;
  const method = call === 'Any' ? 'ALL' : call.toUpperCase();
  return { type: 'http', name: `${method} ${pattern}`, method, route: pattern, how: `${receiver}.${call}() registration` };
}

/**
 * The fields of a cobra.Command literal this module uses, or null when the text is not one.
 * @param {string} body From the opening `{`.
 * @returns {{ use: string|null, runs: boolean }|null}
 */
function cobraLiteral(body) {
  if (!body.startsWith('{')) return null;
  // Only top-level fields: a nested literal's `Use:` belongs to another command.
  const top = topLevelText(body);
  const use = /(?:^|[\s,{])Use\s*:\s*("([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`)/.exec(top);
  const runs = /(?:^|[\s,{])(Run|RunE)\s*:/.test(top);
  if (use) return { use: use[2] ?? use[3] ?? null, runs };
  // `Use: aliasName`, `Use: ext.Name()`: a name known only at run time, shown as `<expr>`.
  const dynamic = /(?:^|[\s,{])Use\s*:\s*([^,\n}]+)/.exec(top);
  return { use: dynamic ? `<${dynamic[1].trim()}>` : null, runs };
}

/**
 * `body` with every nested bracket's content blanked, so a field search sees only the
 * literal's own fields. Strings stay (they hold `Use:`'s value).
 * @param {string} body @returns {string}
 */
function topLevelText(body) {
  let depth = 0;
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === '`') {
      const e = stringEnd(body, i, ch, 'go');
      if (depth <= 1) out += body.slice(i, e);
      i = e;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    if (depth <= 1) out += ch;
    if (ch === ')' || ch === '}' || ch === ']') depth--;
    i++;
  }
  return out;
}

/** `(*Foo).Bar` -> `Bar`, `pkg.Bar` -> `Bar`. @param {string} label @returns {string} */
function simpleGoName(label) {
  const m = /([A-Za-z_]\w*)\s*$/.exec(label);
  return m ? m[1] : label;
}

/**
 * @param {string|null} use @param {string} relPath @param {string} fnName
 * @param {EntryFacts|undefined} facts @param {string} how
 * @returns {EntryInfo}
 */
function cobraEntry(use, relPath, fnName, facts, how) {
  const word = use ? use.trim().split(/\s+/)[0] : null;
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.';
  const prefix = facts && facts.goCommandPrefix ? facts.goCommandPrefix.get(`${dir}#${fnName}`) : undefined;
  const name = word ? (prefix ? `${prefix} ${word}` : word) : `(command built in ${fnName})`;
  return { type: 'cli-command', name, how };
}

/**
 * Every cobra.Command literal in a Go file: its offset, the function that builds it, its
 * `Use` and whether it runs something (`Run`/`RunE`). Bounded by the file's length.
 * @param {string} text
 * @returns {Array<{ at: number, fn: string|null, use: string|null, runs: boolean, runRef: string|null }>}
 */
function cobraCommandsIn(text) {
  const out = [];
  // gofmt writes a literal with no space before `{`; `*cobra.Command {` is a return type.
  const re = /(?<![*\w.])cobra\.Command\{/g;
  let m;
  while ((m = re.exec(text))) {
    const at = m.index + m[0].length - 1;
    const body = bracketBody(text, at, 'go');
    const lit = cobraLiteral(body);
    if (!lit) continue;
    const top = topLevelText(body);
    const ref = /(?:^|[\s,{])RunE?\s*:\s*([A-Za-z_][\w.]*)\s*[,}\n]/.exec(top);
    out.push({ at, fn: enclosingGoFunc(text, m.index), use: lit.use, runs: lit.runs, runRef: ref ? ref[1] : null });
  }
  return out;
}

/** @param {string} text @param {number} at @returns {string|null} */
function enclosingGoFunc(text, at) {
  const re = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/gm;
  let name = null;
  let m;
  while ((m = re.exec(text)) && m.index < at) name = m[1];
  return name;
}

// ---------------------------------------------------------------------------------------
// Declaration entries: the function itself is an entry point.

/**
 * Whether the function at `pos` (its name's offset) is itself an entry point.
 * @param {{ language: EntryLanguage, text: string, pos: number, label: string,
 *   relPath: string, facts?: EntryFacts }} input
 * @returns {EntryInfo|null}
 */
function declarationEntry(input) {
  const { language } = input;
  if (language === 'ts') return tsDeclarationEntry(input);
  if (language === 'go') return goDeclarationEntry(input);
  if (language === 'python') return pythonDeclarationEntry(input);
  return null;
}

/** The last segment of a dotted label: `Hono.route` -> `route`. @param {string} label */
const lastSegment = (label) => label.split('.').pop() || label;
/** The class part of `Class.method`, or null. @param {string} label */
const classPart = (label) => (label.includes('.') ? label.slice(0, label.lastIndexOf('.')) : null);

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text scanned above a declaration for its decorators. Unit: UTF-16 code units.
const MAX_DECORATOR_CHARS = 3000;

/**
 * The decorators directly above the declaration whose name is at `pos`, nearest first, each
 * as its source text (`@app.get("/x")`). A decorator on the declaration's own line counts.
 * Modifiers (`export`, `async`, `public`) between them and the name are skipped.
 * @param {string} text @param {number} pos
 * @returns {string[]}
 */
function decoratorsAbove(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const floor = Math.max(0, lineStart - MAX_DECORATOR_CHARS);
  // The declaration's own line up to the name, minus keywords, may hold decorators too.
  let end = pos;
  const own = text.slice(lineStart, pos);
  const kw = /(?:\b(?:export|default|async|def|function|public|private|protected|static|abstract|override|readonly|get|set)\b|\*|\s)*$/.exec(own);
  if (kw) end = lineStart + kw.index;
  const out = [];
  for (let guard = 0; guard < 32; guard++) {
    let i = end;
    while (i > floor && /\s/.test(text[i - 1])) i--;
    if (i <= floor) break;
    let start;
    if (text[i - 1] === ')') {
      const open = matchingOpenBackward(text, i - 1, floor);
      if (open < 0) break;
      start = open;
    } else start = i;
    const name = /@[A-Za-z_$][\w$.]*\s*$/.exec(text.slice(Math.max(floor, start - 200), start));
    if (!name) break;
    const decoStart = start - name[0].length;
    out.push(text.slice(decoStart, i).replace(/\s+/g, ' '));
    end = decoStart;
  }
  return out;
}

/** @param {string} text @param {number} close @param {number} floor @returns {number} */
function matchingOpenBackward(text, close, floor) {
  let depth = 0;
  for (let i = close; i >= floor; i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** @param {{ text: string, pos: number, label: string, relPath: string, facts?: EntryFacts }} input @returns {EntryInfo|null} */
function tsDeclarationEntry({ text, pos, label, relPath, facts }) {
  const name = lastSegment(label);
  const nextRoute = nextJsRoute(relPath, name, text);
  if (nextRoute) return nextRoute;

  for (const deco of decoratorsAbove(text, pos)) {
    const verb = /^@(Get|Post|Put|Delete|Patch|Head|Options|All)\s*\(\s*(?:(['"`])([^'"`]*)\2)?/.exec(deco);
    if (verb) {
      const prefix = controllerPrefix(text, pos);
      const sub = verb[3] || '';
      const route = joinRoute(prefix, sub);
      const method = verb[1].toUpperCase();
      return { type: 'http', name: `${method} ${route}`, method, route, how: `@${verb[1]}() decorator` };
    }
    const msg = /^@(MessagePattern|EventPattern|OnEvent|SubscribeMessage)\s*\(\s*(?:(['"`])([^'"`]*)\2)?/.exec(deco);
    if (msg) return { type: 'event', name: msg[3] || name, how: `@${msg[1]}() decorator` };
    const job = /^@(Cron|Interval|Timeout|Process)\s*\(/.exec(deco);
    if (job) return { type: 'job', name, how: `@${job[1]}() decorator` };
  }

  // A named handler registered in this same file: `app.get('/x', handler)`.
  const reg = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${HTTP_VERBS.join('|')}|use|route)\\s*\\(\\s*(['"\`])(\\/[^'"\`\\n]*)\\3\\s*,(?:[^;]{0,200}?[,\\s(])?${escapeRe(name)}\\s*[,)]`);
  const r = name.length > 1 ? reg.exec(text) : null;
  if (r) {
    const method = ['use', 'route', 'all'].includes(r[2]) ? 'ALL' : r[2].toUpperCase();
    return { type: 'http', name: `${method} ${r[4]}`, method, route: r[4], how: `passed to ${r[1]}.${r[2]}() in this file` };
  }
  const ipc = new RegExp(`\\bipcMain\\s*\\.\\s*(handle|handleOnce|on|once)\\s*\\(\\s*([^,]{1,120}),\\s*${escapeRe(name)}\\s*\\)`).exec(text);
  if (ipc && name.length > 1) return { type: 'ipc', name: ipc[2].trim().replace(/^['"`]|['"`]$/g, ''), how: `passed to ipcMain.${ipc[1]}() in this file` };

  const ui = uiRouteOf(text, name);
  if (ui) return ui;

  const pub = tsPublicName({ text, label, relPath, facts });
  if (pub) return pub;

  // A package `bin` file's module code is program start, not an entry: ./impact-paths.js
  // ends such a path as a top of kind `app-start`.
  return null;
}

/**
 * A component (or loader) a router registers in this file: TanStack Router's
 * `createFileRoute('/x')({ component: Name })`, `createRoute({ path: '/x', component })`,
 * `createRootRoute({ component })`, and React Router's `{ path: '/x', element: <Name/> }` or
 * `<Route path="/x" element={<Name/>} />`.
 * @param {string} text @param {string} name
 * @returns {EntryInfo|null}
 */
function uiRouteOf(text, name) {
  if (name.length < 2 || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const n = escapeRe(name);
  const ref = new RegExp(`\\b(?:component|Component|pendingComponent|errorComponent|loader|beforeLoad)\\s*:\\s*${n}\\b|\\belement\\s*[:=]\\s*\\{?\\s*<\\s*${n}\\b`, 'g');
  let m;
  while ((m = ref.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 1500), m.index);
    const file = /createFileRoute\s*\(\s*(['"`])([^'"`]*)\1\s*\)\s*\(\s*\{[^]*$/.exec(before);
    if (file && !/\}\s*\)/.test(before.slice(file.index + file[0].indexOf('{')))) return { type: 'ui-route', name: file[2], route: file[2], how: 'TanStack Router file route' };
    if (/createRootRoute(?:WithContext\s*<[^>]*>\s*\(\s*\))?\s*\(\s*\{[^}]*$/.test(before)) return { type: 'ui-route', name: '/', route: '/', how: 'TanStack Router root route' };
    const pathed = /\bpath\s*[:=]\s*\{?\s*(['"`])([^'"`]*)\1[^{}<>]*$/.exec(before);
    if (pathed) return { type: 'ui-route', name: pathed[2], route: pathed[2], how: 'router route definition' };
  }
  return null;
}

/** @param {string} p */
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/** @param {string} prefix @param {string} sub */
function joinRoute(prefix, sub) {
  const joined = `/${[prefix, sub].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  return joined;
}

/** The `@Controller('x')` prefix of the class enclosing `pos`, or ''. @param {string} text @param {number} pos */
function controllerPrefix(text, pos) {
  const before = text.slice(0, pos);
  const re = /@Controller\s*\(\s*(?:(['"`])([^'"`]*)\1|\{[^}]*path\s*:\s*(['"`])([^'"`]*)\3)?/g;
  let last = null;
  let m;
  while ((m = re.exec(before))) last = m;
  return last ? (last[2] || last[4] || '') : '';
}

const NEXT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Next.js route handlers (`app/**\/route.ts` exporting `GET`…), API routes (`pages/api/**`,
 * default export) and pages (`app/**\/page.tsx`, `pages/**`, default export).
 * @param {string} relPath @param {string} name @param {string} text
 * @returns {EntryInfo|null}
 */
function nextJsRoute(relPath, name, text) {
  const appRoute = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/.exec(relPath);
  if (appRoute && NEXT_METHODS.has(name)) {
    const route = appRouteOf(appRoute[1]);
    return { type: 'http', name: `${name} ${route}`, method: name, route, how: 'Next.js route handler' };
  }
  const isDefault = new RegExp(`export\\s+default\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*)?${escapeRe(name)}\\b|export\\s+default\\s+${escapeRe(name)}\\s*;?\\s*$`, 'm').test(text);
  const api = /(?:^|\/)pages\/(api\/(?:[^/]+\/)*[^/]+?)\.[cm]?[jt]sx?$/.exec(relPath);
  if (api && isDefault) {
    const route = `/${api[1].replace(/\/index$/, '')}`;
    return { type: 'http', name: `ALL ${route}`, method: 'ALL', route, how: 'Next.js API route' };
  }
  const page = /(?:^|\/)app\/((?:[^/]+\/)*)page\.[jt]sx?$/.exec(relPath);
  if (page && isDefault) {
    const route = appRouteOf(page[1]);
    return { type: 'ui-route', name: route, route, how: 'Next.js page' };
  }
  return null;
}

/** `(group)/users/[id]/` -> `/users/[id]`. @param {string} dirs */
function appRouteOf(dirs) {
  const parts = dirs.split('/').filter(Boolean).filter((p) => !/^\(.*\)$/.test(p) && !p.startsWith('@'));
  return `/${parts.join('/')}`;
}

/**
 * Public API of a published package: the function (or a public method of a class) is
 * exported by a file `facts.tsPublic` lists.
 * @param {{ text: string, label: string, relPath: string, facts?: EntryFacts }} input
 * @returns {EntryInfo|null}
 */
function tsPublicName({ text, label, relPath, facts }) {
  const listed = facts && facts.tsPublic ? facts.tsPublic.get(relPath) : undefined;
  if (!listed) return null;
  const cls = classPart(label);
  const name = lastSegment(label);
  const exported = (/** @type {string} */ n) => (listed === '*' ? tsExportsName(text, n) : listed.has(n) || (listed.has('default') && tsDefaultExport(text, n)));
  if (cls) {
    const top = cls.split('.')[0];
    if (!exported(top)) return null;
    if (name.startsWith('#') || name.startsWith('_') || tsMemberIsPrivate(text, name)) return null;
    return { type: 'public-api', name: `${top}.${name}`, how: 'public method of an exported class' };
  }
  if (!exported(name)) return null;
  return { type: 'public-api', name, how: 'exported from a package entry point' };
}

/** @param {string} text @param {string} name */
function tsExportsName(text, name) {
  const n = escapeRe(name);
  if (new RegExp(`export\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:function\\s*\\*?|class|const|let|var|enum|namespace)\\s+${n}\\b`).test(text)) return true;
  const lists = text.match(/export\s*(?:type\s*)?\{[^}]*\}(?!\s*from)/g) || [];
  return lists.some((l) => new RegExp(`(?:[{,]\\s*)${n}\\s*(?:[,}]|as\\b)`).test(l));
}

/** @param {string} text @param {string} name */
function tsDefaultExport(text, name) {
  return new RegExp(`export\\s+default\\s+(?:async\\s+)?(?:abstract\\s+)?(?:function\\s*\\*?|class)?\\s*${escapeRe(name)}\\b`).test(text);
}

/** @param {string} text @param {string} name */
function tsMemberIsPrivate(text, name) {
  return new RegExp(`(?:^|\\n)\\s*(?:private|protected)\\s+(?:static\\s+)?(?:readonly\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?${escapeRe(name)}\\s*[(:=<]`).test(text);
}

/** @param {{ text: string, pos: number, label: string, relPath: string, facts?: EntryFacts }} input @returns {EntryInfo|null} */
function goDeclarationEntry({ text, pos, label, relPath, facts }) {
  const name = simpleGoName(label);
  const isMainPackage = /^package\s+main\b/m.test(text) && /^func\s+main\s*\(\s*\)/m.test(text);
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.';
  // A main under script/, scripts/, tools/ or hack/, or behind `//go:build ignore`, is a
  // developer tool (`go run script/build.go`), not the application. Its package-level code
  // (named after the file) runs with it.
  if (isMainPackage && isGoDevTool(relPath, text) && ((name === 'main' && !label.includes('.')) || label === basename(relPath))) {
    return { type: 'dev-tool', name: relPath, how: name === 'main' ? 'func main of a developer script' : 'package-level code of a developer script' };
  }
  if (name === 'main' && !label.includes('.') && isMainPackage) {
    return { type: 'main', name: dir, how: 'func main of package main' };
  }
  const commands = cobraCommandsIn(text);
  // The function builds a command that runs something: changing it changes the command.
  const built = commands.find((c) => c.fn === name && c.runs);
  if (built && !label.includes(')')) return cobraEntry(built.use, relPath, name, facts, 'builds a cobra.Command');
  // The function is a command's `RunE: name` (or `Run: name`).
  const runner = commands.find((c) => c.runRef && simpleGoName(c.runRef) === name);
  if (runner) return cobraEntry(runner.use, relPath, runner.fn || name, facts, 'a cobra.Command Run function');
  // A named handler registered in this file: `http.HandleFunc("/x", name)`.
  const reg = new RegExp(`\\b([A-Za-z_]\\w*)\\s*\\.\\s*(HandleFunc|Handle|GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\\s*\\(\\s*"([^"\\n]*)"\\s*,\\s*(?:[A-Za-z_][\\w.]*\\.)?${escapeRe(name)}\\s*[,)]`).exec(text);
  if (reg && name.length > 1) return goHttpEntry(reg[1], reg[2], reg[3]);
  void pos;
  return null;
}

/** @param {string} relPath @param {string} text */
function isGoDevTool(relPath, text) {
  return /(?:^|\/)(?:script|scripts|tools|hack)\//.test(relPath)
    || /^\/\/go:build\s+ignore\b|^\/\/\s*\+build\s+ignore\b/m.test(text);
}

/** @param {{ text: string, pos: number, label: string, relPath: string, facts?: EntryFacts }} input @returns {EntryInfo|null} */
function pythonDeclarationEntry({ text, pos, label, relPath, facts }) {
  const name = lastSegment(label);
  for (const deco of decoratorsAbove(text, pos)) {
    const route = /^@([A-Za-z_][\w.]*)\.(get|post|put|delete|patch|head|options|route|api_route|websocket)\s*\(\s*(?:(['"])([^'"]*)\3)?([^\n]*)/.exec(deco);
    if (route) {
      const kind = route[2];
      let method = kind.toUpperCase();
      if (kind === 'route' || kind === 'api_route') {
        const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(route[5] || '');
        method = methods ? methods[1].replace(/['"\s]/g, '').toUpperCase().replace(/,/g, '|') : (kind === 'route' ? 'GET' : 'ALL');
      }
      if (kind === 'websocket') method = 'WS';
      const path = route[4] ?? '';
      return { type: 'http', name: `${method} ${path}`, method, route: path, how: `@${route[1]}.${kind}() decorator` };
    }
    const cmd = /^@([A-Za-z_][\w.]*?)\.?(command|group)\s*\(?\s*(?:(['"])([^'"]*)\3)?/.exec(deco);
    if (cmd && /^@(click|typer|[A-Za-z_]\w*)\.(command|group)\b|^@(command|group)\b/.test(deco)) {
      return { type: 'cli-command', name: cmd[4] || name.replace(/_/g, '-'), how: `@${cmd[1] ? `${cmd[1]}.` : ''}${cmd[2]} decorator` };
    }
    const task = /^@(?:([A-Za-z_]\w*)\.)?(task|shared_task|periodic_task|job|actor)\b/.exec(deco);
    if (task) return { type: 'job', name, how: `@${task[1] ? `${task[1]}.` : ''}${task[2]} decorator` };
  }
  const listed = facts && facts.pyPublic ? facts.pyPublic.get(relPath) : undefined;
  if (listed) {
    const cls = classPart(label);
    if (cls) {
      const top = cls.split('.')[0];
      const privateName = name.startsWith('_') && !(name.startsWith('__') && name.endsWith('__'));
      // A special method (`__init__`, `__aiter__`, `__enter__`…) of a public class is public
      // API too: users reach it through the protocol (construction, iteration, `with`).
      const special = name.startsWith('__') && name.endsWith('__');
      if (listed.has(top) && !privateName) return { type: 'public-api', name: `${top}.${name}`, how: special ? 'special method of a class in __all__ (used through its protocol)' : 'public method of a class in __all__' };
    } else if (listed.has(name)) {
      return { type: 'public-api', name, how: 'listed in a package __all__' };
    }
  }
  return null;
}

module.exports = {
  entryLanguageOf, declarationEntry, callSiteEntry, cobraCommandsIn, enclosingBrackets,
  MAX_SCAN_CHARS,
};
