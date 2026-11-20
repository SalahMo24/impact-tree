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
// What a route cannot know is visible: a `<group>`/`<inherited>`/`<area>` piece in it, or the
// entry's `caveat` (`prefix may come from the caller`, `conventional route`), which every view
// of an entry shows after its name.
// Not seen, so a path stopping there reads `top-unidentified`/`unknown`, not "no entry": a
// controller whose base class is in another file and is not named `*Controller`/
// `ControllerBase` (nor marked `[ApiController]`), or a `*Controller` without ASP.NET evidence
// in its file (a global using cannot be seen; see `isController`), likewise a SignalR hub
// (`isHub`); the actions of an abstract or generic base controller (routed under each derived controller's name); a handler
// registered in another file than its declaration or through a variable;
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
  const m = /^(\$@|@\$|\$|@)?"((?:[^"\\]|\\.|"")*)"\s*$/.exec(t);
  // An interpolated string with a hole (`$"{Base}/items"`) is not known.
  if (m && m[1] && m[1].includes('$') && /(?:^|[^{])\{(?!\{)/.test(m[2])) return `<${t.replace(/\s+/g, ' ')}>`;
  return m ? m[2] : `<${t.replace(/\s+/g, ' ')}>`;
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
 * @typedef {{ kw: number, kind: string, name: string, bases: string[], head: Head, generic: boolean, open: number, close: number }} Cls
 * `bases`: each base-list entry as written (`IFoo<Bar>`); `generic`: the class has type
 * parameters; `open`/`close`: its body's braces (`close` -1 when not found).
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
    const generic = /^\s*</.test(b.slice(m.index + m[0].length, m.index + m[0].length + 40));
    found = { kw: m.index, kind: m[0].split(/\s/)[0], name: m[1].replace(/^@/, ''), bases, head: headOf(b, m.index), generic, open, close };
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

/** @typedef {{ name: string, head: Head, paramsText: string, generic: boolean }} Method `generic`: it has type parameters. */

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
  return { name: id[0].replace(/^@/, ''), head, paramsText: close < 0 ? '' : b.slice(open + 1, close), generic: after[0].includes('<') };
}

/** An interface name by convention: `ISessionController`. @param {string} name */
const looksLikeInterface = (name) => /^I[A-Z]/.test(name);

const FRAMEWORK_BASES = new Set(['Controller', 'ControllerBase']);

/** ASP.NET MVC in the file: a `using` of its namespace (a global using elsewhere cannot be seen). */
const MVC_USING = /\busing\s+(?:static\s+)?Microsoft\s*\.\s*AspNetCore\s*\.\s*Mvc\b/;
/** An MVC routing attribute anywhere in a list: `[HttpGet]`, `[Authorize, Route("x")]`. */
const MVC_ATTR = /[[,]\s*(?:Microsoft\s*\.\s*AspNetCore\s*\.\s*Mvc\s*\.\s*)?(?:Http(?:Get|Post|Put|Delete|Patch|Head|Options)|Route|AcceptVerbs|ApiController)(?:Attribute)?\s*[\](,]/;

/**
 * Whether a class's base chain, read through `facts.csControllerRoutes`, reaches the framework
 * base `Controller`/`ControllerBase` or a class in a file that uses ASP.NET MVC.
 * @param {string} name @param {import('./entry-points').EntryFacts} [facts]
 * @param {{ ns: string, usings: string[] }} [scope] the derived class's file, see `baseFacts`
 */
function baseIsMvc(name, facts, scope) {
  const map = facts && facts.csControllerRoutes;
  for (let guard = 0; map && guard < 6; guard++) {
    const info = baseFacts(map, name, scope);
    if (!info) { const all = map.get(name); return !!(all && all.candidates && all.candidates.every((c) => c.mvc)); }
    if (info.mvc) return true;
    if (!info.base) return false;
    if (FRAMEWORK_BASES.has(info.base)) return true;
    name = info.base;
  }
  return false;
}

/**
 * A controller, as ASP.NET finds one: `[ApiController]` or `[Controller]`, or a base class
 * `Controller`/`ControllerBase`; or, with ASP.NET evidence, a name ending in `Controller` with
 * no base list (a POCO controller) or a base class named `*Controller`/`*ControllerBase` (an
 * `I…` interface name does not count). Evidence: the file uses `Microsoft.AspNetCore.Mvc`, the
 * class or one of its members carries an MVC routing attribute, or (with facts) the base
 * chain reaches the framework base or a file that uses MVC. Without it a Unity
 * `PlayerController` or a class based on `CharacterController` is no controller.
 * `[NonController]` is never one.
 * @param {Cls} cls @param {string} [b] the blanked file text @param {import('./entry-points').EntryFacts} [facts]
 */
function isController(cls, b, facts) {
  if (cls.head.attrs.some((a) => a.name === 'NonController')) return false;
  if (cls.head.attrs.some((a) => a.name === 'ApiController' || a.name === 'Controller')) return true;
  const classBases = cls.bases.map(baseName).filter((x) => !looksLikeInterface(x));
  if (classBases.some((x) => FRAMEWORK_BASES.has(x))) return true;
  const named = classBases.find((x) => /Controller(?:Base)?$/.test(x));
  if (!named && !(!cls.bases.length && /Controller$/.test(cls.name))) return false;
  if (b === undefined) return false;
  if (MVC_USING.test(b)) return true;
  if (cls.head.attrs.some((x) => x.name === 'Route')) return true;
  if (cls.close > cls.open && MVC_ATTR.test(b.slice(cls.open, cls.close))) return true;
  return !!named && baseIsMvc(named, facts, fileScope(b, cls.kw));
}

const HTTP_ATTR = /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/;

/** SignalR in the file: a `using` of its namespace (a global using elsewhere cannot be seen). */
const SIGNALR_USING = /\busing\s+(?:static\s+)?Microsoft\s*\.\s*AspNetCore\s*\.\s*SignalR\b/;

/**
 * A SignalR hub: based on `Hub`/`Hub<T>` with ASP.NET evidence, the base written
 * `Microsoft.AspNetCore.SignalR.Hub` or a `using Microsoft.AspNetCore.SignalR` in the file
 * (the same evidence style as `isController`: a `Hub` of another library is no hub).
 * @param {Cls} cls @param {string} b
 */
function isHub(cls, b) {
  const hub = cls.bases.find((x) => baseName(x) === 'Hub');
  return !!hub && (/^(?:global::)?Microsoft\s*\.\s*AspNetCore\s*\.\s*SignalR\s*\.\s*Hub\b/.test(hub) || SIGNALR_USING.test(b));
}

/**
 * `[controller]`, `[action]` and (when the class has `[Area]`) `[area]` filled.
 * @param {string} route @param {string} controller @param {string} action @param {string|null} area
 */
const fill = (route, controller, action, area) => {
  const r = route.replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, action);
  return area === null ? r : r.replace(/\[area\]/gi, area);
};

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

/** Members a controller inherits or overrides that ASP.NET never routes. */
const NOT_ACTIONS = new Set(['OnActionExecuting', 'OnActionExecuted', 'OnActionExecutionAsync', 'Dispose', 'ToString', 'Equals', 'GetHashCode']);

/**
 * The action name ASP.NET gives a method: `[ActionName("x")]`, else the method name with an
 * `Async` suffix removed (`SuppressAsyncSuffixInActionNames`, true by default).
 * @param {string} text @param {string} b @param {Method} m
 */
function actionNameOf(text, b, m) {
  const a = m.head.attrs.find((x) => x.name === 'ActionName');
  const t = a ? templateOf(text, b, a) : null;
  return t !== null && !t.startsWith('<') ? t : m.name.replace(/(.)Async$/, '$1');
}

/**
 * A public non-static, non-generic method of a controller class (see `isController`) not
 * marked `[NonAction]` and not an override of a framework member (`OnActionExecuting`,
 * `Dispose`...; any override when the class derives from `Controller`/`ControllerBase`
 * directly). Routes: the class `[Route]` combined with each `[Http*]` (or `[AcceptVerbs]`, or a
 * `[Route]` on the action) template. A class without `[Route]` inherits its base class's (the
 * attribute is inherited): read from `facts.csControllerRoutes`, and shown as `<inherited>`
 * when the base is not among them. An action with no attribute route at all (none on the
 * class, own or inherited, nor on the action) is conventionally routed: shown as
 * `/{Controller}/{Action}`, the default `MapDefaultControllerRoute` pattern
 * (`/{Area}/{Controller}/{Action}` for an `[Area]` class, the `MapAreaControllerRoute` form),
 * with the caveat `conventional route` and said so in `how` (a custom `MapControllerRoute`
 * pattern is not read). `[area]` in an attribute route is filled from `[Area]`.
 * An abstract or generic controller is never routed under its own name: each concrete
 * controller deriving from it exposes its actions under its own name, so it gives no entry
 * (the derived controllers' actions are not listed here).
 * @param {string} text @param {string} b @param {Method} m @param {Cls|null} cls
 * @param {import('./entry-points').EntryFacts} [facts] @returns {EntryInfo|null}
 */
function controllerEntry(text, b, m, cls, facts) {
  if (!cls || !isController(cls, b, facts)) return null;
  if (cls.head.mods.has('abstract') || cls.generic) return null;
  const { attrs, mods } = m.head;
  if (!mods.has('public') || mods.has('static') || m.generic || attrs.some((a) => a.name === 'NonAction')) return null;
  if (NOT_ACTIONS.has(m.name)) return null;
  if (mods.has('override') && cls.bases.map(baseName).some((x) => FRAMEWORK_BASES.has(x))) return null;
  const classAttr = cls.head.attrs.find((a) => a.name === 'Route');
  let classRoute = classAttr ? (templateOf(text, b, classAttr) ?? '') : '';
  /** No attribute route on the class, own or inherited: an action without one is conventional. */
  let classless = !classAttr && !cls.head.attrs.some((a) => a.name === 'ApiController');
  if (!classAttr) {
    const inherited = inheritedRoute(cls.bases, facts, fileScope(b, cls.kw));
    if (inherited !== null) { classRoute = inherited; if (inherited !== '') classless = false; }
  }
  const controller = cls.name.replace(/Controller$/, '');
  const action = actionNameOf(text, b, m);
  const areaAttr = cls.head.attrs.find((a) => a.name === 'Area');
  const areaName = areaAttr ? templateOf(text, b, areaAttr) : null;
  const area = areaAttr ? (areaName !== null && !areaName.startsWith('<') ? areaName : '<area>') : null;
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
  let conventional = false;
  for (const f of found) {
    const conv = classless && f.template === null;
    conventional ||= conv;
    const route = conv ? joinRoute(area === null ? controller : `${area}/${controller}`, action) : fill(combine(classRoute, f.template), controller, action, area);
    const key = `${f.method} ${route}`;
    if (!seen.has(key)) { seen.add(key); lines.push({ method: f.method, route }); }
  }
  const methods = [...new Set(lines.map((l) => l.method))];
  const how = conventional
    ? `${cls.name} action, conventional route (MapDefaultControllerRoute / MapControllerRoute): ${area === null ? '' : '{area}/'}{controller}/{action} assumed, a custom pattern is not read`
    : attrs.some((a) => HTTP_ATTR.test(a.name) || a.name === 'AcceptVerbs') ? `${cls.name} action with an HTTP attribute` : `public method of controller ${cls.name}`;
  return {
    type: 'http', name: lines.map((l) => `${l.method} ${l.route}`).join(', '),
    method: methods.join('|'), route: lines[0].route, how, ...(conventional ? { caveat: 'conventional route' } : {}),
  };
}

/**
 * The namespace a declaration at `pos` is in (file-scoped `namespace X;` or the blocks
 * around it, joined) and the namespaces the file imports with plain `using X;`.
 * @param {string} b @param {number} pos @returns {{ ns: string, usings: string[] }}
 */
function fileScope(b, pos) {
  const parts = [];
  const re = /\bnamespace\s+([\p{L}_][\p{L}\p{N}_.\s]*?)\s*([;{])/gu;
  let m;
  while ((m = re.exec(b)) && m.index < pos) {
    if (m[2] === ';') { parts.push(m[1]); continue; }
    const open = m.index + m[0].length - 1;
    const close = matchOf(b, open);
    if (close < 0 || close > pos) parts.push(m[1]);
  }
  const usings = [...b.matchAll(/(?:^|[;{}\n])\s*(?:global\s+)?using\s+([\p{L}_][\p{L}\p{N}_.\s]*?)\s*;/gu)].map((u) => u[1].replace(/\s+/g, ''));
  return { ns: parts.map((x) => x.replace(/\s+/g, '')).join('.'), usings };
}

/**
 * A base class's facts. A name declared by more than one class with different facts
 * (`candidates`) is resolved as C# looks a name up: the class in the derived file's own or an
 * enclosing namespace (innermost first), else the only one in a namespace it imports; null
 * when that still leaves more than one, or none.
 * @param {NonNullable<import('./entry-points').EntryFacts['csControllerRoutes']>} map @param {string} name
 * @param {{ ns: string, usings: string[] }} [scope]
 * @returns {{ route: string|null, base: string|null, mvc?: boolean }|null|undefined} undefined: not known
 */
function baseFacts(map, name, scope) {
  const info = map.get(name);
  if (!info || !info.candidates) return info;
  if (!scope) return null;
  const enclosing = info.candidates.filter((c) => c.ns === scope.ns || scope.ns.startsWith(`${c.ns}.`) || c.ns === '')
    .sort((x, y) => y.ns.length - x.ns.length);
  if (enclosing.length) return enclosing.length === 1 || enclosing[0].ns.length > enclosing[1].ns.length ? enclosing[0] : null;
  const imported = info.candidates.filter((c) => scope.usings.includes(c.ns));
  return imported.length === 1 ? imported[0] : null;
}

/**
 * The route a class inherits from its base classes, `''` when the chain reaches the framework
 * base with none, `'<inherited>'` when a base is not known (not read, or no facts: a preview;
 * or a name more than one class declares that `scope` does not settle, see `baseFacts`).
 * Null when the class has no base class to inherit from.
 * @param {string[]} bases @param {import('./entry-points').EntryFacts} [facts]
 * @param {{ ns: string, usings: string[] }} [scope] the derived class's file @returns {string|null}
 */
function inheritedRoute(bases, facts, scope) {
  const classBases = bases.map(baseName).filter((x) => !looksLikeInterface(x));
  if (!classBases.length || classBases.every((x) => FRAMEWORK_BASES.has(x))) return null;
  const map = facts && facts.csControllerRoutes;
  let name = classBases.find((x) => !FRAMEWORK_BASES.has(x)) || '';
  for (let guard = 0; guard < 5; guard++) {
    const info = map ? baseFacts(map, name, scope) : undefined;
    if (!info) return '<inherited>';
    if (info.route !== null) return info.route;
    if (!info.base || FRAMEWORK_BASES.has(info.base)) return '';
    name = info.base;
  }
  return '<inherited>';
}

/**
 * The `[Route]` and base class of each class a file declares, for `facts.csControllerRoutes`;
 * `mvc`: the file uses ASP.NET MVC or the class is `[ApiController]`/`[Controller]` (evidence
 * that a class deriving from it is a controller, see `isController`).
 * @param {string} text @param {string} b the blanked text
 * `ns`: the namespace the class is in (see `fileScope`).
 * @returns {Array<{ name: string, route: string|null, base: string|null, mvc: boolean, ns: string }>}
 */
function classRoutesOf(text, b) {
  const out = [];
  const fileMvc = MVC_USING.test(b);
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
    const mvc = fileMvc || cls.head.attrs.some((a) => a.name === 'ApiController' || a.name === 'Controller');
    out.push({ name: cls.name, route: route ? (templateOf(text, b, route) ?? '') : null, base, mvc, ns: fileScope(b, cls.kw).ns });
  }
  return out;
}

/**
 * @typedef {{ receiver: string, call: string, at: number, route: string|null, methods: string[],
 *   handler: string|null, qualifier: string|null, ownerKw: number, branch: boolean }} MapCall `handler`: a
 *   method-group handler's name; `qualifier`: the type (last segment) or `this` it is written
 *   with, null when bare; `ownerKw`: the `class` keyword offset of the class holding the call,
 *   -1 outside any (top-level statements); `branch`: the handler is a pipeline branch
 *   (`branchLambda`).
 */

const MAP_RE = /\b([A-Za-z_]\w*)\s*\.\s*(Map(?:Get|Post|Put|Delete|Patch|Methods)?)\s*\(/g;

/** @type {{ b: string, calls: MapCall[] }|null} */
let lastMapCalls = null;

/** The verbs of a MapMethods array argument: `"GET"` strings and `HttpMethods.Get`. @param {string} text @param {[number, number]|undefined} arg @returns {string[]} */
const verbsIn = (text, arg) => (arg ? (text.slice(arg[0], arg[1]).match(/"[A-Za-z]+"|\bHttpMethods\s*\.\s*[A-Za-z]+/g) || []).map((x) => x.replace(/^"|"$|^HttpMethods\s*\.\s*/g, '').toUpperCase()) : []);

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
    const h = args[idx] ? /^\s*((?:[A-Za-z_]\w*\s*\.\s*)*)([A-Za-z_]\w*)\s*$/.exec(b.slice(args[idx][0], args[idx][1])) : null;
    const qualifier = h && h[1].trim() ? h[1].replace(/\s+/g, '').replace(/\.$/, '').split('.').pop() || null : null;
    const owner = h ? enclosingClass(b, at) : null;
    calls.push({
      receiver: m[1], call: m[2], at, route, methods: m[2] === 'MapMethods' ? verbsIn(text, args[1]) : [],
      handler: h ? h[2] : null, qualifier, ownerKw: owner ? owner.kw : -1, branch: m[2] === 'Map' && branchLambda(b, args[idx]),
    });
  }
  lastMapCalls = { b, calls };
  return calls;
}

/** The offset of the `(` opening the `)` at `close` (blanked text), or -1. @param {string} b @param {number} close */
function matchBack(b, close) {
  let depth = 0;
  for (let i = close; i >= 0 && i > close - 8000; i--) {
    const c = b[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Words before `(…) {` that open a statement block, not a method body. */
const STATEMENT_WORDS = /^(?:if|while|for|foreach|switch|using|lock|catch|fixed|when|return|new|await|nameof|typeof|sizeof|default|checked|unchecked|else)$/;

/**
 * The scope a variable used at `before` is looked up in: the body of the enclosing method,
 * constructor or local function (statement blocks, lambdas and initializers are looked
 * through), or of a type, or the whole file for top-level statements. `params`: that method's
 * parameter list; `lambdaParams`: the parameters of the lambdas passed on the way out, with
 * their type as written (null when untyped) and `app`: the lambda is `UseEndpoints`'s
 * argument, whose parameter is the application's endpoint builder.
 * @param {string} b @param {number} before
 * @returns {{ start: number, params: string|null, lambdaParams: LambdaParam[] }}
 */
function scopeOf(b, before) {
  /** @type {LambdaParam[]} */
  const lambdaParams = [];
  let depth = 0;
  for (let i = before - 1; i >= 0; i--) {
    const c = b[i];
    if (c === '}') { depth++; continue; }
    if (c !== '{') continue;
    if (depth > 0) { depth--; continue; }
    let j = i - 1;
    while (j >= 0 && /\s/.test(b[j])) j--;
    if (b[j] === '>' && b[j - 1] === '=') {
      const ahead = b.slice(Math.max(0, j - 400), j - 1);
      const lp = /(?:\(([^()]*)\)|([A-Za-z_]\w*))\s*$/.exec(ahead);
      const app = !!lp && /\bUseEndpoints\s*\(\s*(?:async\s+)?$/.test(ahead.slice(0, lp.index));
      if (lp) {
        for (const p of (lp[1] ?? lp[2]).split(',')) {
          const n = /^(?:([\w.<>?]+)\s+)?@?([A-Za-z_]\w*)$/.exec(p.trim());
          if (n) lambdaParams.push({ name: n[2], type: n[1] ? baseName(n[1]) : null, app });
        }
      }
      continue;
    }
    if (b[j] === ')') {
      const open = matchBack(b, j);
      if (open < 0) return { start: i + 1, params: null, lambdaParams };
      const head = b.slice(Math.max(0, open - 300), open);
      const id = /(@?[\p{L}_][\p{L}\p{N}_]*)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*$/u.exec(head);
      if (!id || STATEMENT_WORDS.test(id[1]) || /\bnew\s*$/.test(head.slice(0, head.length - id[0].length))) continue;
      return { start: i + 1, params: b.slice(open + 1, j), lambdaParams };
    }
    const word = /([A-Za-z_]\w*)$/.exec(b.slice(Math.max(0, j - 20), j + 1));
    if (/[=,([\]]/.test(b[j] || '') || (word && /^(?:else|try|finally|do|unsafe|checked|unchecked|switch)$/.test(word[1]))) continue;
    return { start: i + 1, params: null, lambdaParams };
  }
  return { start: 0, params: null, lambdaParams };
}

/** @typedef {{ name: string, type: string|null, app: boolean }} LambdaParam */

/**
 * Builder parameter types the caller passes: an `IEndpointRouteBuilder` may be a route group
 * (`app.MapGroup("/v1").MapX()`), so a route registered on one has the caveat `prefix may come
 * from the caller`. `WebApplication` is sealed and is the application: no caveat.
 * `IApplicationBuilder` has no `MapGet`; its `Map("/x", b => …)` branches the middleware
 * pipeline and is no endpoint (see `mapEntry`).
 */
const CALLER_BUILDERS = new Set(['IEndpointRouteBuilder', 'IApplicationBuilder']);

/**
 * Members of a builder chain known to add no path: versioning, metadata, filters,
 * conventions. Any other call in a group's chain (`app.MapApiV1()`) may add one.
 */
const PREFIX_FREE = /^(?:NewVersionedApi|HasApiVersion|HasDeprecatedApiVersion|MapToApiVersion|IsApiVersionNeutral|ReportApiVersions|With[A-Z]\w*|Require[A-Z]\w*|Allow[A-Z]\w*|Add\w*Filter\w*|Produces\w*|Accepts|Exclude\w*|Disable\w*|CacheOutput|ShortCircuit|ConfigureAwait)$/;

/**
 * The `MapGroup("…")` prefix a variable carries, from its last assignment before `before` in
 * the enclosing method (local function, or top-level statements): `var v1 =
 * vApi.MapGroup("api/catalog").HasApiVersion(1, 0)` follows `vApi` back too. What is not seen
 * there is a `<group>` piece, so the route reads as partial: a `RouteGroupBuilder` (or
 * untyped) parameter, a field, a method's return (`var g = Grp(app)`), a call in the chain
 * other than `MapGroup`, `Build` and the `PREFIX_FREE` ones (`app.MapApiV1()`). A
 * `WebApplication` parameter, `builder.Build()` and `UseEndpoints(e => …)`'s parameter are
 * the application and contribute nothing. A parameter typed `IEndpointRouteBuilder` or
 * `IApplicationBuilder`, or another lambda's parameter, contributes nothing and sets
 * `ctx.caller`: the caller may pass a group (`ctx.appBuilder`: the type is `IApplicationBuilder`).
 * @param {string} text @param {string} b @param {string} variable @param {number} before
 * @param {MapCtx} ctx @param {number} [depth] @returns {string}
 */
function groupPrefix(text, b, variable, before, ctx, depth = 0) {
  if (depth > 4) return '<group>';
  const scope = scopeOf(b, before);
  const re = new RegExp(`(?<![\\w.])${escapeRe(variable)}\\s*=(?!=|>)`, 'g');
  const window = b.slice(scope.start, before);
  let last = null;
  let m;
  while ((m = re.exec(window))) last = m;
  if (!last) {
    const lambda = scope.lambdaParams.find((p) => p.name === variable);
    const param = lambda || scope.params === null ? null : splitTopAngle(scope.params)
      .map((p) => new RegExp(`(?:^|\\s)([\\w.<>?]+)\\s+@?${escapeRe(variable)}\\s*(?:=[^]*)?$`).exec(p.trim())).find(Boolean);
    const type = lambda ? lambda.type : param ? baseName(param[1]) : null;
    if (type === 'IApplicationBuilder') ctx.appBuilder = true;
    const caller = lambda ? !lambda.app : !!type && CALLER_BUILDERS.has(type);
    if (caller) ctx.caller = true;
    return lambda || caller || type === 'WebApplication' ? '' : '<group>';
  }
  const start = scope.start + last.index + last[0].length;
  const semi = b.indexOf(';', start);
  const rhs = b.slice(start, semi < 0 || semi - start > 1500 ? start + 1500 : semi);
  const root = /^\s*(?:await\s+)?(@?[A-Za-z_]\w*)\s*(\(|<)?/.exec(rhs);
  /** @type {string[]} */
  let pieces = [];
  let built = false;
  // The chain's calls at its top level (arguments are skipped): `.MapGroup("x")` adds `x`,
  // `.Build()` starts over at the application, an unknown call adds a `<group>` piece.
  const member = /\.\s*@?([A-Za-z_]\w*)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(/y;
  for (let i = start, end = start + rhs.length; i < end;) {
    const c = b[i];
    if (c === '(' || c === '[' || c === '{') { const close = matchOf(b, i); i = close < 0 ? end : close + 1; continue; }
    member.lastIndex = i;
    const mm = c === '.' ? member.exec(b) : null;
    if (!mm) { i++; continue; }
    const open = i + mm[0].length - 1;
    const close = matchOf(b, open);
    if (mm[1] === 'MapGroup') {
      const first = close < 0 ? null : splitTop(b, open + 1, close)[0];
      if (first) pieces.push(literal(text.slice(first[0], first[1])));
    } else if (mm[1] === 'Build') { built = true; pieces = []; }
    else if (!PREFIX_FREE.test(mm[1])) pieces.push('<group>');
    i = close < 0 ? end : close + 1;
  }
  let base = '';
  if (!root || built || root[1] === 'new' || root[1] === 'WebApplication') base = '';
  else if (root[2]) base = '<group>';   // a method's return: `Grp(app)`
  else if (root[1] !== variable) base = groupPrefix(text, b, root[1], scope.start + last.index, ctx, depth + 1);
  return [base, ...pieces].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

/** @typedef {{ caller: boolean, appBuilder: boolean }} MapCtx */

/**
 * A plain `Map("/x", b => { … })` branching the middleware pipeline: its handler is a lambda
 * with one parameter typed `IApplicationBuilder`, or untyped, not `async` and with a block
 * body that returns nothing (an `Action<IApplicationBuilder>`; a request handler returns a
 * `Task`) or an expression body calling `Use…`/`Run…`/`Map…` on it.
 * @param {string} b @param {[number, number]|undefined} arg
 */
function branchLambda(b, arg) {
  if (!arg) return false;
  const t = b.slice(arg[0], arg[1]);
  if (/^\s*\(\s*(?:[\w.]+\.)?IApplicationBuilder\s+@?\w+\s*\)\s*=>/.test(t)) return true;
  const m = /^\s*(?:\(\s*@?([A-Za-z_]\w*)\s*\)|@?([A-Za-z_]\w*))\s*=>\s*/.exec(t);
  if (!m || m[2] === 'async') return false;
  const body = t.slice(m[0].length);
  if (body.startsWith('{')) return !/\breturn\b/.test(body);
  return new RegExp(`^${escapeRe(m[1] ?? m[2])}\\s*\\.\\s*(?:Use|Run|Map)\\w*\\s*[(<]`).test(body);
}

/**
 * The entry of a Map call; null for a plain `Map` that branches the middleware pipeline
 * (`IApplicationBuilder.Map`, see `branchLambda`), which runs once at startup.
 * @param {string} text @param {string} b @param {MapCall} c @returns {EntryInfo|null}
 */
function mapEntry(text, b, c) {
  if (c.route === null || (c.call === 'Map' && c.branch)) return null;
  /** @type {MapCtx} */
  const ctx = { caller: false, appBuilder: false };
  const route = joinRoute(groupPrefix(text, b, c.receiver, c.at, ctx), c.route);
  if (c.call === 'Map' && ctx.appBuilder) return null;
  const method = c.call === 'MapMethods' ? (c.methods.join('|') || 'ALL') : c.call === 'Map' ? 'ALL' : c.call.slice(3).toUpperCase();
  return {
    type: 'http', name: `${method} ${route}`, method, route,
    how: `${c.receiver}.${c.call}() registration${ctx.caller ? '; a prefix the caller adds is not followed' : ''}`,
    ...(ctx.caller ? { caveat: 'prefix may come from the caller' } : {}),
  };
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
    return mapEntry(text, b, { receiver: m[1], call: m[2], at, route, methods: m[2] === 'MapMethods' ? verbsIn(text, args[1]) : [], handler: null, qualifier: null, ownerKw: -1, branch: m[2] === 'Map' && branchLambda(b, args[1]) });
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
    if (mods.has('public') && !mods.has('static') && isHub(cls, b)) return { type: 'event', name: where, how: `SignalR hub method of ${cls.name}` };
  }

  // A named handler registered in this file: `api.MapGet("/items", GetItems)`.
  if (m.name.length > 1) {
    // `Other.Get` names a method of class `Other`; a bare `Get` (or `this.Get`) one of the class
    // holding the call, or a local function there (top-level statements: outside any class).
    const ownerKw = found ? found.kw : -1;
    const reg = mapCalls(text, b).find((c) => c.handler === m.name
      && (c.qualifier && c.qualifier !== 'this' ? !!found && found.name === c.qualifier : c.ownerKw === ownerKw));
    if (reg) {
      const e = mapEntry(text, b, reg);
      if (e) return { ...e, how: `passed to ${reg.receiver}.${reg.call}() in this file${/; (.*)$/.exec(e.how)?.[0] ?? ''}` };
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
