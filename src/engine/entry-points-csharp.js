// @ts-check
'use strict';
// C# entry points (C-D7), part of ./entry-points.js. Text only, no compilation, and pure.
// Every pattern matches on the text blanked by ../languages/csharp/lexer.js `blank` (comments
// and string contents are spaces, offsets unchanged), so a comment or a string never
// matches; a route is read from the raw text at the same offsets, since blanking erases it.
//
// Recognised: ASP.NET controller actions, minimal-API handlers (`x.MapGet("/r", Handler)` in
// the same file, or a call inside the registered lambda), gRPC service overrides, hosted
// services, integration-event handlers, SignalR hub methods, `static Main`.
// Not seen, so a path stopping there reads `top-unidentified`/`unknown`, not "no entry": a
// controller whose base class is in another file and is not named `*Controller`/
// `ControllerBase` (nor marked `[ApiController]`); a `[Route]` inherited from a base class;
// a handler registered in another file than its declaration or through a variable;
// `IScheduledTask` and `IEventConsumer<T>` (no rule in v1); MediatR (`Send`/`Publish` are
// not followed yet, see `unreachableReason`).

/** @typedef {import('./entry-points').EntryInfo} EntryInfo */

const MAX_ENCLOSING = 8;

/** @param {string} p */
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string} prefix @param {string} sub */
function joinRoute(prefix, sub) {
  return `/${[prefix, sub].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
}

/** Where a member's declaration starts: just after the previous member's `;`, `{` or `}`. @param {string} b @param {number} pos */
function segmentStart(b, pos) {
  const floor = Math.max(0, pos - 6000);
  let depth = 0;
  for (let i = pos - 1; i >= floor; i--) {
    const c = b[i];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') { if (depth > 0) depth--; else return i + 1; }
    else if (depth === 0 && (c === ';' || c === '{' || c === '}')) return i + 1;
  }
  return floor;
}

/** The offset of the bracket closing the one at `open` (blanked text), or -1 within 60000 characters. @param {string} b @param {number} open */
function matchOf(b, open) {
  let depth = 0;
  const end = Math.min(b.length, open + 60000);
  for (let i = open; i < end; i++) {
    const c = b[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** The offsets `[start, end)` of the top-level comma-separated parts between `from` and `to`. @param {string} b @param {number} from @param {number} to @returns {Array<[number, number]>} */
function splitTop(b, from, to) {
  /** @type {Array<[number, number]>} */
  const out = [];
  let depth = 0;
  let at = from;
  for (let i = from; i < to; i++) {
    const c = b[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push([at, i]); at = i + 1; }
  }
  if (b.slice(at, to).trim()) out.push([at, to]);
  return out;
}

/**
 * The value of a C# string literal, or `<expr>` for any other expression (a constant), so a
 * route is never shown as if it were known.
 * @param {string} rawArg @returns {string}
 */
function literal(rawArg) {
  const t = rawArg.trim();
  const m = /^(?:\$@|@\$|\$|@)?"((?:[^"\\]|\\.|"")*)"\s*$/.exec(t);
  return m ? m[1] : `<${t.replace(/\s+/g, ' ')}>`;
}

const MODS = /\b(?:public|private|protected|internal|static|abstract|virtual|override|async|sealed|new|extern|unsafe|partial|readonly|required|file)\b/g;

/**
 * @typedef {{ name: string, open: number, close: number }} Attr `open`/`close`: the
 *   argument list's parentheses, -1 when it has none.
 * @typedef {{ attrs: Attr[], mods: Set<string>, typeText: string }} Head
 */

/**
 * The attribute lists, modifiers and remaining text (the type) between a declaration's start
 * and the offset `pos` of its name (or its `class` keyword).
 * @param {string} b @param {number} pos @returns {Head}
 */
function headOf(b, pos) {
  let i = segmentStart(b, pos);
  /** @type {Attr[]} */
  const attrs = [];
  for (let guard = 0; guard < 24; guard++) {
    while (i < pos && /\s/.test(b[i])) i++;
    if (b[i] !== '[') break;
    const close = matchOf(b, i);
    if (close < 0 || close >= pos) break;
    for (const [s, e] of splitTop(b, i + 1, close)) {
      const part = b.slice(s, e);
      if (/^\s*return\s*:/.test(part)) continue;
      const m = /^\s*(?:(?:method|param|property|field|event|type|assembly|module)\s*:\s*)?@?([\p{L}\p{N}_.]+)\s*(\()?/u.exec(part);
      if (!m) continue;
      const name = m[1].split('.').pop() || m[1];
      const open = m[2] ? s + m[0].length - 1 : -1;
      attrs.push({ name: name.replace(/Attribute$/, ''), open, close: open >= 0 ? matchOf(b, open) : -1 });
    }
    i = close + 1;
  }
  const rest = b.slice(i, pos);
  return { attrs, mods: new Set(rest.match(MODS) || []), typeText: rest.replace(MODS, ' ').trim() };
}

/** The arguments of an attribute or call, as `{ name, raw }` (`name`: the `Name =`/`name:` label). @param {string} text @param {string} b @param {number} open @param {number} close */
function argsOf(text, b, open, close) {
  if (open < 0 || close < 0) return [];
  return splitTop(b, open + 1, close).map(([s, e]) => {
    const raw = text.slice(s, e).trim();
    const m = /^(@?[\p{L}_][\p{L}\p{N}_]*)\s*(?:=(?!=)|:(?!:))\s*([^]*)$/u.exec(raw);
    return m ? { name: m[1], raw: m[2] } : { name: '', raw };
  });
}

/**
 * The route template an attribute carries: its first positional argument or `Template =`,
 * null when it has none.
 * @param {string} text @param {string} b @param {Attr} a @returns {string|null}
 */
function templateOf(text, b, a) {
  const args = argsOf(text, b, a.open, a.close);
  const t = args.find((x) => !x.name) || args.find((x) => /^template$/i.test(x.name));
  return t ? literal(t.raw) : null;
}

/**
 * @typedef {{ kw: number, kind: string, name: string, bases: string[], head: Head }} Cls
 * `bases`: each base-list entry as written (`IFoo<Bar>`).
 */

/**
 * The innermost class, struct, record or interface whose body holds `pos`.
 * @param {string} b @param {number} pos @returns {Cls|null}
 */
function enclosingClass(b, pos) {
  const re = /\b(?:record\s+(?:class|struct)|class|record|struct|interface)\s+(@?[\p{L}_][\p{L}\p{N}_]*)/gu;
  /** @type {Cls|null} */
  let found = null;
  let m;
  while ((m = re.exec(b)) && m.index < pos) {
    if (m[1] === 'where' || m[1] === 'new') continue;
    // Generic parameters, primary-constructor parameters, base list, constraints, up to `{`.
    let angle = 0;
    let paren = 0;
    let colon = -1;
    let whereAt = -1;
    let open = -1;
    for (let j = m.index + m[0].length; j < b.length && j < m.index + 4000; j++) {
      const c = b[j];
      if (c === '<') angle++;
      else if (c === '>') angle--;
      else if (c === '(') paren++;
      else if (c === ')') paren--;
      else if (angle <= 0 && paren <= 0) {
        if (c === ';') break;
        if (c === ':' && colon < 0 && b[j + 1] !== ':' && whereAt < 0) colon = j;
        else if (c === 'w' && whereAt < 0 && /^where\s+[\p{L}_]/u.test(b.slice(j, j + 12)) && /\s/.test(b[j - 1] || ' ')) whereAt = j;
        else if (c === '{') { open = j; break; }
      }
    }
    if (open < 0 || open > pos) continue;
    const close = matchOf(b, open);
    if (close >= 0 && close < pos) continue;
    const baseText = colon < 0 ? '' : b.slice(colon + 1, whereAt >= 0 ? whereAt : open);
    const bases = baseText ? splitTopAngle(baseText).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
    found = { kw: m.index, kind: m[0].split(/\s/)[0], name: m[1].replace(/^@/, ''), bases, head: headOf(b, m.index) };
  }
  return found;
}

/** Comma-separated parts, commas inside `<>` or `()` not splitting. @param {string} s @returns {string[]} */
function splitTopAngle(s) {
  const out = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(') depth++;
    else if (c === '>' || c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(at, i)); at = i + 1; }
  }
  out.push(s.slice(at));
  return out;
}

/** The type name of a base-list entry without namespace and arguments: `A.B<C>` -> `B`. @param {string} base */
const baseName = (base) => (/^(?:global::)?((?:[\p{L}_][\p{L}\p{N}_]*\s*\.\s*)*)([\p{L}_][\p{L}\p{N}_]*)/u.exec(base) || [])[2] || base;

/** @typedef {{ name: string, head: Head, paramsText: string }} Method */

/** The method whose name starts at `pos`, or null (a property, a constructor, a type). @param {string} b @param {number} pos @returns {Method|null} */
function methodAt(b, pos) {
  const id = /^@?[\p{L}_][\p{L}\p{N}_]*/u.exec(b.slice(pos, pos + 200));
  if (!id) return null;
  const after = /^\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(/.exec(b.slice(pos + id[0].length, pos + id[0].length + 300));
  if (!after) return null;
  const head = headOf(b, pos);
  // A constructor has no type before its name.
  if (!head.typeText) return null;
  const open = pos + id[0].length + after[0].length - 1;
  const close = matchOf(b, open);
  return { name: id[0].replace(/^@/, ''), head, paramsText: close < 0 ? '' : b.slice(open + 1, close) };
}

/** An interface name by convention: `ISessionController`. @param {string} name */
const looksLikeInterface = (name) => /^I[A-Z]/.test(name);

/**
 * A controller: `[ApiController]` or `[Controller]`; a base class named `Controller`,
 * `ControllerBase` or ending in `Controller`/`ControllerBase` (an `I…` interface name does
 * not count); or, with no base list at all, a name ending in `Controller` (a POCO controller).
 * @param {Cls} cls
 */
function isController(cls) {
  return cls.head.attrs.some((a) => a.name === 'ApiController' || a.name === 'Controller')
    || cls.bases.some((x) => !looksLikeInterface(baseName(x)) && /Controller(?:Base)?$/.test(baseName(x)))
    || (!cls.bases.length && /Controller$/.test(cls.name));
}

const HTTP_ATTR = /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/;

/** `[controller]` and `[action]` filled. @param {string} route @param {string} controller @param {string} action */
const fill = (route, controller, action) => route.replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, action);

/**
 * ASP.NET attribute routing: a template starting `~/` or `/` replaces the class route; any
 * other is appended to it.
 * @param {string} classRoute @param {string|null} template
 */
function combine(classRoute, template) {
  if (template === null) return joinRoute(classRoute, '');
  if (template.startsWith('~/')) return joinRoute('', template.slice(2));
  if (template.startsWith('/')) return joinRoute('', template);
  return joinRoute(classRoute, template);
}

/**
 * A public non-static method of a controller class (`[ApiController]`, or named or based on
 * `*Controller`/`ControllerBase`) not marked `[NonAction]`. Routes: the class `[Route]`
 * combined with each `[Http*]` (or `[AcceptVerbs]`, or a `[Route]` on the action) template.
 * A class without `[Route]` inherits its base class's (the attribute is inherited): read from
 * `facts.csControllerRoutes`, and shown as `<inherited>` when the base is not among them.
 * @param {string} text @param {string} b @param {Method} m @param {Cls|null} cls
 * @param {import('./entry-points').EntryFacts} [facts] @returns {EntryInfo|null}
 */
function controllerEntry(text, b, m, cls, facts) {
  if (!cls || !isController(cls)) return null;
  const { attrs, mods } = m.head;
  if (!mods.has('public') || mods.has('static') || attrs.some((a) => a.name === 'NonAction')) return null;
  const classAttr = cls.head.attrs.find((a) => a.name === 'Route');
  let classRoute = classAttr ? (templateOf(text, b, classAttr) ?? '') : '';
  if (!classAttr) {
    const inherited = inheritedRoute(cls.bases, facts);
    if (inherited !== null) classRoute = inherited;
  }
  const controller = cls.name.replace(/Controller$/, '');
  const routeTemplates = attrs.filter((a) => a.name === 'Route').map((a) => templateOf(text, b, a));
  /** @type {Array<{ method: string, template: string|null }>} */
  const found = [];
  for (const a of attrs) {
    const v = HTTP_ATTR.exec(a.name);
    if (v) {
      const t = templateOf(text, b, a);
      if (t !== null) found.push({ method: v[1].toUpperCase(), template: t });
      else for (const rt of routeTemplates.length ? routeTemplates : [null]) found.push({ method: v[1].toUpperCase(), template: rt });
    } else if (a.name === 'AcceptVerbs') {
      const args = argsOf(text, b, a.open, a.close);
      const methods = args.filter((x) => !x.name && x.raw.startsWith('"')).map((x) => literal(x.raw).toUpperCase());
      const t = args.find((x) => /^route$/i.test(x.name));
      for (const method of methods.length ? methods : ['ALL']) found.push({ method, template: t ? literal(t.raw) : (routeTemplates[0] ?? null) });
    }
  }
  if (!found.length) for (const rt of routeTemplates.length ? routeTemplates : [null]) found.push({ method: 'ALL', template: rt });
  const seen = new Set();
  /** @type {Array<{ method: string, route: string }>} */
  const lines = [];
  for (const f of found) {
    const route = fill(combine(classRoute, f.template), controller, m.name);
    const key = `${f.method} ${route}`;
    if (!seen.has(key)) { seen.add(key); lines.push({ method: f.method, route }); }
  }
  const methods = [...new Set(lines.map((l) => l.method))];
  return {
    type: 'http', name: lines.map((l) => `${l.method} ${l.route}`).join(', '),
    method: methods.join('|'), route: lines[0].route,
    how: attrs.some((a) => HTTP_ATTR.test(a.name) || a.name === 'AcceptVerbs') ? `${cls.name} action with an HTTP attribute` : `public method of controller ${cls.name}`,
  };
}

const FRAMEWORK_BASES = new Set(['Controller', 'ControllerBase']);

/**
 * The route a class inherits from its base classes, `''` when the chain reaches the framework
 * base with none, `'<inherited>'` when a base is not known (not read, or no facts: a preview).
 * Null when the class has no base class to inherit from.
 * @param {string[]} bases @param {import('./entry-points').EntryFacts} [facts] @returns {string|null}
 */
function inheritedRoute(bases, facts) {
  const classBases = bases.map(baseName).filter((x) => !looksLikeInterface(x));
  if (!classBases.length || classBases.every((x) => FRAMEWORK_BASES.has(x))) return null;
  const map = facts && facts.csControllerRoutes;
  let name = classBases.find((x) => !FRAMEWORK_BASES.has(x)) || '';
  for (let guard = 0; guard < 5; guard++) {
    const info = map ? map.get(name) : undefined;
    if (!info) return '<inherited>';
    if (info.route !== null) return info.route;
    if (!info.base || FRAMEWORK_BASES.has(info.base)) return '';
    name = info.base;
  }
  return '<inherited>';
}

/**
 * The `[Route]` and base class of each class a file declares, for `facts.csControllerRoutes`.
 * @param {string} text @param {string} b the blanked text
 * @returns {Array<{ name: string, route: string|null, base: string|null }>}
 */
function classRoutesOf(text, b) {
  const out = [];
  const re = /\b(?:record\s+(?:class|struct)|class|record)\s+(@?[\p{L}_][\p{L}\p{N}_]*)/gu;
  let m;
  while ((m = re.exec(b))) {
    if (m[1] === 'where' || m[1] === 'new') continue;
    // The class whose body starts after this header: enclosingClass at just inside its brace.
    const open = b.indexOf('{', m.index);
    if (open < 0) continue;
    const cls = enclosingClass(b, open + 1);
    if (!cls || cls.kw !== m.index) continue;
    const route = cls.head.attrs.find((a) => a.name === 'Route');
    const base = cls.bases.map(baseName).find((x) => !looksLikeInterface(x)) || null;
    out.push({ name: cls.name, route: route ? (templateOf(text, b, route) ?? '') : null, base });
  }
  return out;
}

/** @typedef {{ receiver: string, call: string, at: number, route: string|null, methods: string[], handler: string|null }} MapCall */

const MAP_RE = /\b([A-Za-z_]\w*)\s*\.\s*(Map(?:Get|Post|Put|Delete|Patch|Methods)?)\s*\(/g;

/** @type {{ b: string, calls: MapCall[] }|null} */
let lastMapCalls = null;

/** The `"GET"` strings of a MapMethods array argument. @param {string} text @param {[number, number]|undefined} arg @returns {string[]} */
const verbsIn = (text, arg) => (arg ? (text.slice(arg[0], arg[1]).match(/"([A-Za-z]+)"/g) || []).map((x) => x.slice(1, -1).toUpperCase()) : []);

/** The route argument's value, null when there is none. @param {string} text @param {[number, number]} arg @returns {string|null} */
function routeArg(text, arg) {
  const raw = text.slice(arg[0], arg[1]);
  return raw.trim() ? literal(raw) : null;
}

/**
 * Every `x.MapGet("/r", Handler)` (and Post, Put, Delete, Patch, Methods, plain Map) call of a
 * file, with its route and the handler when it is a method group. The last file is cached.
 * @param {string} text @param {string} b @returns {MapCall[]}
 */
function mapCalls(text, b) {
  if (lastMapCalls && lastMapCalls.b === b) return lastMapCalls.calls;
  /** @type {MapCall[]} */
  const calls = [];
  MAP_RE.lastIndex = 0;
  let m;
  while ((m = MAP_RE.exec(b))) {
    const at = m.index + m[0].length - 1;
    const close = matchOf(b, at);
    if (close < 0) continue;
    const args = splitTop(b, at + 1, close);
    if (!args.length) continue;
    const route = routeArg(text, args[0]);
    // A plain `Map(` needs a path starting `/`: `mapper.Map("x", y)` is not a route.
    if (m[2] === 'Map' && !(route !== null && route.startsWith('/'))) continue;
    const idx = m[2] === 'MapMethods' ? 2 : 1;
    const h = args[idx] ? /^\s*(?:[A-Za-z_]\w*\s*\.\s*)*([A-Za-z_]\w*)\s*$/.exec(b.slice(args[idx][0], args[idx][1])) : null;
    calls.push({ receiver: m[1], call: m[2], at, route, methods: m[2] === 'MapMethods' ? verbsIn(text, args[1]) : [], handler: h ? h[1] : null });
  }
  lastMapCalls = { b, calls };
  return calls;
}

/**
 * The `MapGroup("…")` prefix a variable carries, from its last assignment before `before`:
 * `var v1 = vApi.MapGroup("api/catalog").HasApiVersion(1, 0)` follows `vApi` back too. A
 * parameter or an unseen assignment contributes nothing.
 * @param {string} text @param {string} b @param {string} variable @param {number} before @param {number} [depth]
 * @returns {string}
 */
function groupPrefix(text, b, variable, before, depth = 0) {
  if (depth > 4) return '';
  const re = new RegExp(`(?<![\\w.])${escapeRe(variable)}\\s*=(?!=|>)`, 'g');
  const from = Math.max(0, before - 20000);
  const window = b.slice(from, before);
  let last = null;
  let m;
  while ((m = re.exec(window))) last = m;
  if (!last) return '';
  const start = from + last.index + last[0].length;
  const semi = b.indexOf(';', start);
  const rhs = b.slice(start, semi < 0 || semi - start > 1500 ? start + 1500 : semi);
  const root = /^\s*(?:await\s+)?([A-Za-z_]\w*)/.exec(rhs);
  const base = root && root[1] !== variable ? groupPrefix(text, b, root[1], from + last.index, depth + 1) : '';
  const pieces = [];
  const g = /\.\s*MapGroup\s*\(/g;
  let gm;
  while ((gm = g.exec(rhs))) {
    const open = start + gm.index + gm[0].length - 1;
    const close = matchOf(b, open);
    const first = close < 0 ? null : splitTop(b, open + 1, close)[0];
    if (first) pieces.push(literal(text.slice(first[0], first[1])));
  }
  return [base, ...pieces].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

/** @param {string} text @param {string} b @param {MapCall} c @returns {EntryInfo|null} */
function mapEntry(text, b, c) {
  if (c.route === null) return null;
  const route = joinRoute(groupPrefix(text, b, c.receiver, c.at), c.route);
  const method = c.call === 'MapMethods' ? (c.methods.join('|') || 'ALL') : c.call === 'Map' ? 'ALL' : c.call.slice(3).toUpperCase();
  return { type: 'http', name: `${method} ${route}`, method, route, how: `${c.receiver}.${c.call}() registration` };
}

/**
 * The entry a call inside `x.MapGet("/r", (c) => H(c))` makes its enclosing function: the
 * enclosing brackets of the call site include the Map call's parentheses.
 * @param {string} text @param {string} b @param {number} callerPos @param {number} callSiteStart @returns {EntryInfo|null}
 */
function callSiteEntry(text, b, callerPos, callSiteStart) {
  const { enclosingBrackets } = require('./entry-points');
  const stack = enclosingBrackets(b, callerPos, callSiteStart, 'csharp');
  if (!stack) return null;
  for (let k = stack.length - 1, seen = 0; k >= 0 && seen < MAX_ENCLOSING; k--, seen++) {
    const { ch, at } = stack[k];
    if (ch !== '(') continue;
    const m = /\b([A-Za-z_]\w*)\s*\.\s*(Map(?:Get|Post|Put|Delete|Patch|Methods)?)\s*$/.exec(b.slice(Math.max(0, at - 120), at));
    if (!m) continue;
    const close = matchOf(b, at);
    const args = splitTop(b, at + 1, close < 0 ? Math.min(b.length, at + 4000) : close);
    if (!args.length) continue;
    const route = routeArg(text, args[0]);
    if (route === null || (m[2] === 'Map' && !route.startsWith('/'))) continue;
    return mapEntry(text, b, { receiver: m[1], call: m[2], at, route, methods: m[2] === 'MapMethods' ? verbsIn(text, args[1]) : [], handler: null });
  }
  return null;
}

/**
 * @param {{ text: string, blanked: string, pos: number, label: string, relPath: string, facts?: import('./entry-points').EntryFacts }} input
 * @returns {EntryInfo|null}
 */
function declarationEntry({ text, blanked: b, pos, label, relPath, facts }) {
  // The module symbol of top-level statements, named after its file: ./impact-paths.js
  // ends it as program start.
  if (label === basename(relPath)) return null;
  const m = methodAt(b, pos);
  if (!m) return null;
  // An interface's own members are declarations, not handlers.
  const found = enclosingClass(b, pos);
  const cls = found && found.kind === 'interface' ? null : found;
  const controller = controllerEntry(text, b, m, cls, facts);
  if (controller) return controller;

  const { mods } = m.head;
  if (m.name === 'Main' && mods.has('static')) return { type: 'main', name: relPath, how: 'static Main' };

  if (cls) {
    const bases = cls.bases.map(baseName);
    const where = `${cls.name}.${m.name}`;
    if (mods.has('override') && /\bServerCallContext\b/.test(m.paramsText)) {
      // `Greeter.GreeterBase`: the generated base class of service Greeter.
      const svc = cls.bases.map((x) => /^(?:[\p{L}_][\p{L}\p{N}_]*\s*\.\s*)*([\p{L}_][\p{L}\p{N}_]*)\s*\.\s*([\p{L}_][\p{L}\p{N}_]*)/u.exec(x)).find((x) => x && x[2] === `${x[1]}Base`);
      if (svc) return { type: 'http', name: `${svc[1]}/${m.name}`, method: 'GRPC', route: `/${svc[1]}/${m.name}`, how: `gRPC method of ${cls.name}` };
    }
    if (m.name === 'ExecuteAsync' && bases.includes('BackgroundService')) return { type: 'job', name: where, how: 'BackgroundService.ExecuteAsync' };
    if ((m.name === 'StartAsync' || m.name === 'StopAsync') && bases.includes('IHostedService')) return { type: 'job', name: where, how: `IHostedService.${m.name}` };
    if (m.name === 'Handle') {
      const h = cls.bases.find((x) => baseName(x) === 'IIntegrationEventHandler');
      if (h) {
        const ev = /<\s*([^<>,]+?)\s*>/.exec(h);
        return { type: 'event', name: ev ? ev[1] : where, how: 'IIntegrationEventHandler.Handle' };
      }
    }
    if (bases.includes('Hub') && mods.has('public') && !mods.has('static')) return { type: 'event', name: where, how: `SignalR hub method of ${cls.name}` };
  }

  // A named handler registered in this file: `api.MapGet("/items", GetItems)`.
  if (m.name.length > 1) {
    const reg = mapCalls(text, b).find((c) => c.handler === m.name);
    if (reg) {
      const e = mapEntry(text, b, reg);
      if (e) return { ...e, how: `passed to ${reg.receiver}.${reg.call}() in this file` };
    }
  }
  return null;
}

/**
 * Why the method at `pos` is not an entry although a framework calls it: a MediatR handler
 * (`Handle` of an `IRequestHandler<…>` or `INotificationHandler<…>`), which `Send`/`Publish`
 * dispatch to. Null for any other method. For a handler nothing calls, which ends `unknown`
 * with this reason, not as a top (./impact-paths.js).
 * @param {{ text: string, blanked: string, pos: number, label: string, relPath: string }} input
 * @returns {string|null}
 */
function unreachableReason({ text, blanked: b, pos, label, relPath }) {
  void text;
  if (label === basename(relPath)) return null;
  const m = methodAt(b, pos);
  if (!m || m.name !== 'Handle') return null;
  const cls = enclosingClass(b, pos);
  if (!cls || cls.kind === 'interface' || !cls.bases.some((x) => /^(?:IRequestHandler|INotificationHandler)$/.test(baseName(x)))) return null;
  return 'MediatR handler: dispatched by `Send`/`Publish`, which is not followed yet';
}

module.exports = { classRoutesOf, declarationEntry, callSiteEntry, unreachableReason, enclosingClass, methodAt, isController };
