// @ts-check
'use strict';
// The repository facts ./entry-points.js needs, read from disk once per analysis: which
// source files a published package exposes (package.json `exports`/`main`/`module`/`types`
// and the re-exports they lead to), which names a Python package's `__all__` exports, the
// parent command line of each cobra command constructor, and package `bin` files.
//
// Bounded: at most MAX_LISTED paths from git, MAX_FILES_READ files read, each up to
// MAX_FILE_BYTES. A fact cut by a bound is missing, not wrong: a public function it would
// have listed then reads as not an entry, and `notes` says the facts are partial.

const fs = require('fs');
const path = require('path');

// Paths taken from `git ls-files`. Unit: paths.
const MAX_LISTED = 200000;
// Files read for facts. Unit: files. Exhaustion: later files are skipped, `notes` says so.
const MAX_FILES_READ = 4000;
// Largest file read for facts. Unit: bytes. A larger file is skipped.
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * @param {{ repo: string, git: { tryRaw: (args: string[]) => string|null }, languages: Set<string>,
 *   readRel?: (relPath: string) => string|null }} input
 *   `languages`: which of 'ts', 'go', 'python' the analysis has changed functions in.
 *   `readRel`: reads a file by repository-relative path (another revision than the disk,
 *   such as a preview's head); default: the file on disk.
 * @returns {{ facts: import('./entry-points').EntryFacts, notes: string[] }}
 */
function gatherEntryFacts({ repo, git, languages, readRel }) {
  const notes = [];
  const out = git.tryRaw(['ls-files', '--cached', '-z']);
  if (out == null) return { facts: {}, notes: ['entry-point facts not gathered: git could not list the files'] };
  const listed = out.split('\0').filter(Boolean).slice(0, MAX_LISTED);
  const listedSet = new Set(listed);
  let reads = 0;
  let skipped = 0;
  const read = (/** @type {string} */ rel) => {
    if (reads >= MAX_FILES_READ) { skipped++; return null; }
    if (readRel) {
      const text = readRel(rel);
      if (text !== null && text.length > MAX_FILE_BYTES) { skipped++; return null; }
      reads++;
      return text;
    }
    try {
      const abs = path.join(repo, rel);
      if (fs.statSync(abs).size > MAX_FILE_BYTES) { skipped++; return null; }
      reads++;
      return fs.readFileSync(abs, 'utf8');
    } catch { return null; }
  };
  /** @type {import('./entry-points').EntryFacts} */
  const facts = {};
  if (languages.has('ts')) Object.assign(facts, tsFacts(listed, listedSet, read));
  if (languages.has('python')) facts.pyPublic = pythonFacts(listed, listedSet, read);
  if (languages.has('go')) facts.goCommandPrefix = goFacts(listed, read);
  if (skipped) notes.push(`entry-point facts are partial: ${skipped} file(s) not read (over ${MAX_FILES_READ} files or ${MAX_FILE_BYTES / 1024} KB per file)`);
  return { facts, notes };
}

const isNodeModules = (/** @type {string} */ p) => /(?:^|\/)node_modules\//.test(p);
const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Source file a package.json target names: the target itself when it is source, else the
 * same path under `src/` with build directories (`dist`, `build`, `lib`, `out`, and their
 * `cjs`/`esm`/`types` subfolders) removed and the extension swapped.
 * @param {string} pkgDir Repository-relative ('' for the root).
 * @param {string} target @param {Set<string>} listed
 * @returns {string|null}
 */
function sourceOfTarget(pkgDir, target, listed) {
  const join = (/** @type {string} */ p) => path.posix.normalize(path.posix.join(pkgDir, p)).replace(/^\.\//, '');
  const direct = join(target);
  if (listed.has(direct) && !/\.d\.[cm]?ts$/.test(direct) && !/(?:^|\/)(?:dist|build|out)\//.test(target)) return direct;
  const stem = target.replace(/^\.\//, '')
    .replace(/^(?:dist|build|lib|out)\/(?:(?:cjs|esm|mjs|types|es|commonjs|module)\/)?/, '')
    .replace(/\.d\.[cm]?ts$|\.[cm]?jsx?$|\.[cm]?tsx?$/, '');
  for (const base of ['src/', '']) {
    for (const ext of TS_EXT) {
      const candidate = join(`${base}${stem}${ext}`);
      if (listed.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Leaf strings of an `exports` value (conditions nested). @param {unknown} v @param {string[]} out */
function exportTargets(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => exportTargets(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => exportTargets(x, out));
}

/**
 * @param {string[]} listed @param {Set<string>} listedSet @param {(rel: string) => string|null} read
 * @returns {{ tsPublic: Map<string, Set<string>|'*'>, binFiles: Map<string, string> }}
 */
function tsFacts(listed, listedSet, read) {
  /** @type {Map<string, Set<string>|'*'>} */
  const tsPublic = new Map();
  /** @type {Map<string, string>} */
  const binFiles = new Map();
  /** @type {string[]} */
  const queue = [];
  const mark = (/** @type {string} */ file, /** @type {Set<string>|'*'} */ names) => {
    const prior = tsPublic.get(file);
    if (prior === '*') return;
    if (names === '*') { tsPublic.set(file, '*'); queue.push(file); return; }
    const merged = new Set([...(prior || []), ...names]);
    if (prior && merged.size === prior.size) return;
    tsPublic.set(file, merged);
    queue.push(file);
  };
  for (const pj of listed.filter((p) => /(?:^|\/)package\.json$/.test(p) && !isNodeModules(p)).slice(0, 300)) {
    const text = read(pj);
    if (!text) continue;
    let pkg;
    try { pkg = JSON.parse(text); } catch { continue; }
    if (!pkg || typeof pkg !== 'object') continue;
    const dir = path.posix.dirname(pj) === '.' ? '' : path.posix.dirname(pj);
    if (pkg.bin) {
      const bins = typeof pkg.bin === 'string' ? { [String(pkg.name || '').replace(/^@[^/]+\//, '')]: pkg.bin } : pkg.bin;
      for (const [name, target] of Object.entries(bins || {})) {
        const src = typeof target === 'string' ? sourceOfTarget(dir, target, listedSet) : null;
        if (src) binFiles.set(src, name);
      }
    }
    // A private package is not published: its exports serve the monorepo, not users.
    if (pkg.private === true) continue;
    /** @type {string[]} */
    const targets = [];
    if (pkg.exports !== undefined) exportTargets(pkg.exports, targets);
    else for (const k of ['main', 'module', 'types', 'typings']) if (typeof pkg[k] === 'string') targets.push(pkg[k]);
    for (const t of targets) {
      if (t.includes('*')) {
        // `./utils/*` -> every source file under the mapped directory.
        const dirSrc = sourceDirOfPattern(dir, t);
        if (dirSrc !== null) for (const f of listed) if (f.startsWith(dirSrc) && TS_EXT.some((e) => f.endsWith(e)) && !/\.(test|spec)\./.test(f)) mark(f, '*');
        continue;
      }
      const src = sourceOfTarget(dir, t, listedSet);
      if (src && !binFiles.has(src)) mark(src, '*');
    }
  }
  // Follow re-exports from the entry files. Bounded by MAX_FILES_READ through `read`.
  let head = 0;
  while (head < queue.length) {
    const file = queue[head++];
    const text = read(file);
    if (!text) continue;
    const names = tsPublic.get(file);
    for (const re of reExportsOf(text)) {
      const target = resolveRelative(file, re.from, listedSet);
      if (!target) continue;
      if (re.names === '*') { if (names === '*') mark(target, '*'); else continue; }
      else {
        const wanted = new Set([...re.names].filter(([, as]) => names === '*' || /** @type {Set<string>} */ (names).has(as)).map(([orig]) => orig));
        if (wanted.size) mark(target, wanted);
      }
    }
  }
  return { tsPublic, binFiles };
}

/** @param {string} dir @param {string} pattern @returns {string|null} */
function sourceDirOfPattern(dir, pattern) {
  const prefix = pattern.slice(0, pattern.indexOf('*')).replace(/^\.\//, '')
    .replace(/^(?:dist|build|lib|out)\/(?:(?:cjs|esm|mjs|types|es)\/)?/, '');
  const base = dir ? `${dir}/` : '';
  return prefix.startsWith('src/') ? `${base}${prefix}` : `${base}src/${prefix}`;
}

/**
 * Re-exports in a module: `export * from './x'`, `export { a, b as c } from './x'`, and
 * `import { a } from './x'` followed by `export { a }`. Each name pair is [original, exported].
 * @param {string} text
 * @returns {Array<{ from: string, names: '*'|Map<string, string> }>}
 */
function reExportsOf(text) {
  /** @type {Array<{ from: string, names: '*'|Map<string, string> }>} */
  const out = [];
  for (const m of text.matchAll(/export\s*\*\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g)) out.push({ from: m[1], names: '*' });
  for (const m of text.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) out.push({ from: m[2], names: pairs(m[1]) });
  // Imported then exported by name.
  /** @type {Map<string, { from: string, orig: string }>} */
  const imported = new Map();
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const [orig, as] of pairs(m[1])) imported.set(as, { from: m[2], orig });
  }
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g)) imported.set(m[1], { from: m[2], orig: 'default' });
  for (const m of text.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}(?!\s*from)/g)) {
    for (const [local, as] of pairs(m[1])) {
      const imp = imported.get(local);
      if (imp) out.push({ from: imp.from, names: new Map([[imp.orig, as]]) });
    }
  }
  for (const m of text.matchAll(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) {
    const imp = imported.get(m[1]);
    if (imp) out.push({ from: imp.from, names: new Map([[imp.orig, 'default']]) });
  }
  return out;
}

/** `a, b as c, type d` -> Map(a=>a, b=>c, d=>d). @param {string} list */
function pairs(list) {
  /** @type {Map<string, string>} */
  const m = new Map();
  for (const raw of list.split(',')) {
    const t = raw.replace(/\/\*.*?\*\/|\/\/.*$/g, '').trim().replace(/^type\s+/, '');
    if (!t) continue;
    const [orig, as] = t.split(/\s+as\s+/);
    m.set(orig.trim(), (as || orig).trim());
  }
  return m;
}

/** @param {string} from @param {string} spec @param {Set<string>} listed @returns {string|null} */
function resolveRelative(from, spec, listed) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.[cm]?jsx?$/, '');
  for (const cand of [...TS_EXT.map((e) => base + e), ...TS_EXT.map((e) => `${base}/index${e}`)]) if (listed.has(cand)) return cand;
  return null;
}

/**
 * `__all__` of every top-level package `__init__.py` (one whose directory's parent has no
 * `__init__.py`), outside test and docs folders, mapped to the modules the names come from.
 * A name defined in `__init__.py` itself maps to it. Without `__all__`, the package's
 * public (no leading underscore) relative imports.
 * @param {string[]} listed @param {Set<string>} listedSet @param {(rel: string) => string|null} read
 * @returns {Map<string, Set<string>>}
 */
function pythonFacts(listed, listedSet, read) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  const add = (/** @type {string} */ file, /** @type {string} */ name) => {
    if (!out.has(file)) out.set(file, new Set());
    /** @type {Set<string>} */ (out.get(file)).add(name);
  };
  const inits = listed.filter((p) => /(?:^|\/)__init__\.py$/.test(p) && !/(?:^|\/)(?:tests?|docs?|examples?)\//.test(p))
    .filter((p) => { const parent = path.posix.dirname(path.posix.dirname(p)); return !listedSet.has(parent === '.' ? '__init__.py' : `${parent}/__init__.py`); });
  for (const init of inits.slice(0, 50)) {
    const text = read(init);
    if (!text) continue;
    const pkgDir = path.posix.dirname(init);
    /** @type {Map<string, { module: string, orig: string }>} */
    const imports = new Map();
    // Indented imports count too: `if TYPE_CHECKING:` blocks list what a lazy `__getattr__` serves.
    for (const m of text.matchAll(/^[ \t]*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
      const module = m[1];
      for (const part of m[2].replace(/[()]/g, '').split(',')) {
        const t = part.replace(/#.*$/, '').trim();
        if (!t || t === '*') continue;
        const [orig, as] = t.split(/\s+as\s+/).map((s) => s.trim());
        imports.set(as || orig, { module, orig });
      }
    }
    const all = /^__all__\s*(?::[^=]*)?=\s*[[(]([^\])]*)[\])]/m.exec(text);
    const names = all ? [...all[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
      : [...imports.keys()].filter((n) => !n.startsWith('_') && imports.get(n)?.module.startsWith('.'));
    // `from .main import *`: a name is attributed to the star module that defines it.
    const stars = [...text.matchAll(/^[ \t]*from\s+(\.+[\w.]*)\s+import\s+\*/gm)]
      .map((m) => pythonModuleFile(pkgDir, m[1], listedSet)).filter((f) => f !== null)
      .map((f) => ({ file: /** @type {string} */ (f), text: read(/** @type {string} */ (f)) || '' }));
    for (const name of names) {
      const imp = imports.get(name);
      const star = imp ? null : stars.find((m) => new RegExp(`^(?:class|def|async def)\\s+${name.replace(/\W/g, '')}\\b|^${name.replace(/\W/g, '')}\\s*[:=]`, 'm').test(m.text));
      if (star) { add(star.file, name); continue; }
      if (!imp) { add(init, name); continue; }
      const file = pythonModuleFile(pkgDir, imp.module, listedSet);
      if (file) add(file, imp.orig);
      else add(init, name);
    }
  }
  return out;
}

/** @param {string} pkgDir @param {string} module @param {Set<string>} listed @returns {string|null} */
function pythonModuleFile(pkgDir, module, listed) {
  let base;
  if (module.startsWith('.')) {
    const dots = (/^\.+/.exec(module) || [''])[0].length;
    let dir = pkgDir;
    for (let k = 1; k < dots; k++) dir = path.posix.dirname(dir);
    const rest = module.slice(dots).split('.').filter(Boolean).join('/');
    base = rest ? `${dir}/${rest}` : dir;
  } else {
    // Absolute import of the package itself: `from httpx._api import get`.
    const root = path.posix.dirname(pkgDir);
    base = (root === '.' ? '' : `${root}/`) + module.split('.').join('/');
  }
  for (const cand of [`${base}.py`, `${base}/__init__.py`]) if (listed.has(cand)) return cand;
  return null;
}

/**
 * The parent command line of each cobra command constructor: `cmd.AddCommand(pkg.NewCmdX(…))`
 * (or any internal constructor called) in a function that builds a command with `Use: "pr"`
 * makes `<dir of pkg>#NewCmdX` a child of it. Only Go files that mention `cobra` are scanned. Chains are followed up to 6 parents.
 * @param {string[]} listed @param {(rel: string) => string|null} read
 * @returns {Map<string, string>}
 */
function goFacts(listed, read) {
  const { cobraCommandsIn } = require('./entry-points');
  const goFiles = listed.filter((p) => p.endsWith('.go') && !p.endsWith('_test.go') && !/(?:^|\/)(?:vendor|testdata)\//.test(p));
  const modText = listed.includes('go.mod') ? read('go.mod') : null;
  const modulePath = modText ? (/^\s*module\s+(\S+)/m.exec(modText) || [])[1] : undefined;
  /** child key -> { parentKey, parentUse } */
  /** @type {Map<string, { parentKey: string, parentUse: string }>} */
  const parent = new Map();
  /** @type {Map<string, string>} */
  const useOf = new Map();
  for (const file of goFiles) {
    const text = read(file);
    if (!text || !text.includes('cobra')) continue;
    const dir = path.posix.dirname(file);
    const commands = cobraCommandsIn(text);
    for (const c of commands) if (c.fn && c.use) useOf.set(`${dir}#${c.fn}`, c.use.trim().split(/\s+/)[0]);
    const builders = new Set(commands.filter((c) => c.fn).map((c) => /** @type {string} */ (c.fn)));
    if (!builders.size) continue;
    /** @type {Map<string, string>} */
    const aliases = new Map();
    for (const m of text.matchAll(/^\s*(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/gm)) {
      const imp = m[2];
      if (!modulePath || !imp.startsWith(`${modulePath}/`)) continue;
      const impDir = imp.slice(modulePath.length + 1);
      aliases.set(m[1] || impDir.split('/').pop() || impDir, impDir);
    }
    // A constructor called inside a function that builds a command is its subcommand
    // (`cmd.AddCommand(list.NewCmdList(f))`, or through a helper such as `AddGroup`).
    for (const fn of builders) {
      const body = funcBody(text, fn);
      for (const call of body.matchAll(/\b(?:([A-Za-z_]\w*)\.)?(New\w*|new\w*)\s*\(/g)) {
        const childDir = call[1] ? aliases.get(call[1]) : dir;
        if (!childDir || (childDir === dir && call[2] === fn)) continue;
        if (!parent.has(`${childDir}#${call[2]}`)) parent.set(`${childDir}#${call[2]}`, { parentKey: `${dir}#${fn}`, parentUse: '' });
      }
    }
  }
  /** @type {Map<string, string>} */
  const prefix = new Map();
  for (const key of parent.keys()) {
    const words = [];
    let k = /** @type {string|undefined} */ (parent.get(key)?.parentKey);
    for (let guard = 0; k && guard < 6; guard++) {
      const use = useOf.get(k);
      if (use) words.unshift(use);
      k = parent.get(k)?.parentKey;
    }
    if (words.length) prefix.set(key, words.join(' '));
  }
  return prefix;
}

/** The text of top-level function `name`, up to the next top-level `func`. @param {string} text @param {string} name */
function funcBody(text, name) {
  const m = new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*[([]`, 'm').exec(text);
  if (!m) return '';
  const next = text.slice(m.index + m[0].length).search(/^func\s/m);
  return next === -1 ? text.slice(m.index) : text.slice(m.index, m.index + m[0].length + next);
}

module.exports = { gatherEntryFacts, reExportsOf, sourceOfTarget, MAX_FILES_READ };
