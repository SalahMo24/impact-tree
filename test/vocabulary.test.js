'use strict';
// One vocabulary (docs/UX_PLAN.md, gate G8): every word a user reads names an idea the same
// way. This test fails on a retired term in the text a user can read:
//   - package.json `contributes`: command titles and categories, view names, every
//     configuration `title`/`description`/`markdownDescription`/`enumDescriptions`, and
//     every `viewsWelcome` `contents`;
//   - README.md;
//   - the string literals (and the static text of template literals) of the user-facing
//     source modules in SOURCES below.
// Identifiers and comments never trigger it.
//
// The vocabulary (G8):
//   callers not updated   a signature/throw change whose callers were not changed on the call line
//                         (never "stale", never a glyph, never "needs attention" for one change)
//   Needs attention       the filter / summary bucket: callers not updated + check by hand
//   reviewed              the review checkbox: "Mark reviewed" / "Mark not reviewed"
//                         (never tick, untick, ticked)
//   Viewed on GitHub      GitHub's per-file flag (never "viewed" alone)
//   Branch vs base, Branch + uncommitted, Uncommitted (agent), Since checkpoint
//                         the local modes (`MODES[id].label`); the ids stay in settings and CLI flags
//   Preview               the no-checkout pull request view (never "Tier A")
//   Analyse               in UI text; `analyze` stays in identifiers, `npm run analyze` and CLI flags
//
// How strings are found: `literalsOf` below is a small tokenizer, not a parser. It walks the
// source once, skipping `//` and block comments and regular-expression literals, and collects
// the contents of '...' and "..." strings and the static parts of `...` templates (the code
// inside `${...}` is tokenized in turn, so strings nested in it are found too).
//
// Known gaps:
//   - Regular-expression literals are told from division by the previous token (a heuristic);
//     an unusual layout could mislead it. A mistake can only hide or invent a literal, and the
//     self-tests below pin the common layouts.
//   - A phrase split across a `${...}` hole is checked as separate pieces, so a retired phrase
//     that straddles a hole is not seen.
//   - Strings built by concatenation are checked one literal at a time, for the same reason.
//   - Text produced by data (git output, GitHub responses, error messages from libraries) and
//     text in modules not listed in SOURCES (log-only lines, the engine's internals) is not checked.
//   - Source text is not checked for the "viewed" rule inside regular expressions or comments.
//   - Wording that needs judgement (for example "needs attention" used for a single change
//     rather than the bucket) cannot be found mechanically; review catches it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---- the retired terms ---------------------------------------------------------------

/** @type {Array<{ name: string, re: RegExp, use: string }>} */
const RETIRED = [
  { name: 'stale', re: /\bstale\b/i, use: '"callers not updated" (or "out of date" for a ref)' },
  { name: 'un-updated', re: /\bun-?updated\b/i, use: '"callers not updated"' },
  { name: 'tick', re: /\b(un)?tick(ed|s|ing)?\b/i, use: '"reviewed" / "Mark reviewed" / "Mark not reviewed"; "check" for a checkbox' },
  { name: 'Tier A', re: /\bTier A\b/i, use: '"Preview"' },
  { name: 'glyph for a state', re: /⛔/u, use: 'words (no glyph names a state)' },
  // "viewed" must be GitHub's flag, written "Viewed on GitHub". Upper case (the GraphQL
  // enum VIEWED) and "unviewed" are not the word; neither is matched.
  { name: 'viewed alone', re: /\b[Vv]iewed\b(?! on GitHub)/, use: '"Viewed on GitHub"' },
  { name: 'rebind hint', re: /\(rebind it in Keyboard Shortcuts\)|\brebind\b/i, use: 'nothing; the title stays plain' },
  { name: 'state in a title', re: /\(now (showing|hiding)/i, use: 'a plain title; the icon shows the state' },
  { name: 'needing attention', re: /\bneeding attention\b/i, use: '"Needs attention" / "N need attention"' },
  { name: 'analyze', re: /\banalyz(e|es|ing|ed|er)\b/i, use: '"Analyse" (code identifiers and CLI flags keep `analyze`)' },
];

// What is allowed although a retired pattern matches. Each entry says why. A text is
// tested after these are blanked out of it.
/** @type {Array<{ re: RegExp, why: string }>} */
const ALLOWED_TEXT = [
  { re: /npm run analyze\b/g, why: 'the npm script keeps its name' },
  { re: /\bimpact-tree analyze\b/g, why: 'a CLI command line' },
  { re: /--(?:analyze|[a-z-]*analyze[a-z-]*)\b/g, why: 'CLI flags keep their names' },
  { re: /\bimpactTree\.tierA\.maxFiles\b/g, why: 'the setting key stays for compatibility' },
];

// A whole literal that is not text a user reads: a module path, a message type or CSS class
// that the page script and the host agree on. Matched against the entire literal.
/** @type {Array<{ re: RegExp, why: string }>} */
const ALLOWED_LITERALS = [
  { re: /^(\.{1,2}\/|node:)\S*$/, why: 'a module path' },
  { re: /^tick$/, why: 'the page-to-host message type for a review mark (internal protocol)' },
  { re: /^stale$/, why: 'an error code of the review store (internal)' },
  { re: /^STALE$/, why: 'a value of GitHub\'s check run conclusion, validated at the boundary (data, not prose)' },
  { re: /^\[data-act="tick"\]$/, why: 'a selector of the page script' },
  { re: /^analyze$/, why: 'a property name used as a string key' },
];

// Literals inside an HTML/CSS/JS page template: the markup is not text, but its text is.
// These remove only the machine-facing fragments, never prose.
/** @type {Array<{ re: RegExp, why: string }>} */
const ALLOWED_FRAGMENTS = [
  { re: /data-act="tick"/g, why: 'the button\'s action name read by the page script' },
  { re: /act === 'tick'/g, why: 'the page script compares the action name' },
  { re: /type: 'tick'/g, why: 'the page script posts the host message type' },
  { re: /\.stale \{[^}]*\}/g, why: 'the CSS rule of the "not updated" caller marker' },
  { re: /class="stale"/g, why: 'the CSS class of the "not updated" caller marker' },
];

/**
 * The retired terms found in one text.
 * @param {string} text
 * @param {{ fragments?: boolean }} [options] Whether the page-template fragments are allowed too.
 * @returns {Array<{ term: string, match: string, use: string }>}
 */
function retiredIn(text, { fragments = false } = {}) {
  let rest = text;
  for (const a of ALLOWED_TEXT) rest = rest.replace(a.re, ' ');
  if (fragments) for (const a of ALLOWED_FRAGMENTS) rest = rest.replace(a.re, ' ');
  const found = [];
  for (const r of RETIRED) {
    const m = r.re.exec(rest);
    if (m) found.push({ term: r.name, match: m[0], use: r.use });
  }
  return found;
}

// ---- the string extractor ------------------------------------------------------------

/**
 * The text literals of JavaScript source: '...' and "..." strings and the static parts of
 * template literals, without comments or regular expressions. See the header for its limits.
 * @param {string} source
 * @returns {Array<{ text: string, line: number }>}
 */
function literalsOf(source) {
  /** @type {Array<{ text: string, line: number }>} */
  const out = [];
  const n = source.length;
  const lineAt = (/** @type {number} */ index) => source.slice(0, index).split('\n').length;
  /** Braces opened in code, and for each open `${` the depth to return to. */
  let depth = 0;
  /** @type {number[]} */
  const holes = [];
  // The last significant token, to tell a regular expression from a division.
  let prev = '';
  const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '>', '+', '-', '*', '%', '<', '~', '^']);
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'else', 'do']);
  let i = 0;

  /** Scans template text from `from` to the closing backtick or the next `${`. */
  const template = (/** @type {number} */ from) => {
    let text = '';
    let j = from;
    while (j < n) {
      const c = source[j];
      if (c === '\\') { text += source[j + 1] ?? ''; j += 2; continue; }
      if (c === '`') { out.push({ text, line: lineAt(from) }); prev = '`'; return j + 1; }
      if (c === '$' && source[j + 1] === '{') {
        out.push({ text, line: lineAt(from) });
        holes.push(depth);
        depth++;
        prev = '{';
        return j + 2;
      }
      text += c;
      j++;
    }
    out.push({ text, line: lineAt(from) });
    return j;
  };

  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; continue; }
    if (c === '\'' || c === '"') {
      let text = '';
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') { text += source[j + 1] ?? ''; j += 2; continue; }
        text += source[j++];
      }
      out.push({ text, line: lineAt(i) });
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '`') { i = template(i + 1); continue; }
    if (c === '/') {
      if (REGEX_AFTER.has(prev) || REGEX_KEYWORDS.has(prev)) {
        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== '\n') {
          if (source[j] === '\\') { j += 2; continue; }
          if (source[j] === '[') inClass = true;
          else if (source[j] === ']') inClass = false;
          else if (source[j] === '/' && !inClass) break;
          j++;
        }
        i = j + 1;
        while (/[a-z]/.test(source[i] ?? '')) i++;
        prev = '/regex';
        continue;
      }
      prev = '/';
      i++;
      continue;
    }
    if (c === '{') { depth++; prev = '{'; i++; continue; }
    if (c === '}') {
      depth--;
      if (holes.length && holes[holes.length - 1] === depth) { holes.pop(); i = template(i + 1); continue; }
      prev = '}';
      i++;
      continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z_$0-9]/.test(source[j])) j++;
      prev = source.slice(i, j);
      i = j;
      continue;
    }
    // `=>` leaves `>`: a regular expression may follow an arrow.
    prev = c;
    i++;
  }
  return out;
}

test('the extractor finds literals and ignores comments, identifiers and regular expressions', () => {
  const texts = (/** @type {string} */ s) => literalsOf(s).map((l) => l.text);
  assert.deepEqual(texts('const stale = 1; // a stale comment\n/* tick */ f("shown", \'also\');'), ['shown', 'also']);
  assert.deepEqual(texts('const tickCount = untick(staleCallers.tick);'), [], 'identifiers are not text');
  assert.deepEqual(texts('x.replace(/stale "no"/g, \'kept\');'), ['kept'], 'a regular expression is not text');
  assert.deepEqual(texts('const half = a / b; const s = "after division";'), ['after division']);
  assert.deepEqual(texts('const re = /[/]"x"/; f("y")'), ['y'], 'a slash inside a character class does not end the expression');
  assert.deepEqual(texts('`one ${n} two ${f(\'in\')} three`'), ['one ', ' two ', 'in', ' three'], 'static parts and nested code');
  assert.deepEqual(texts('`a ${ {k: "v"}.k } b`'), ['a ', 'v', ' b'], 'braces inside a hole do not close it early');
  assert.deepEqual(texts('`a ${`inner ${x}`} b`'), ['a ', 'inner ', '', ' b'], 'nested templates');
  assert.deepEqual(texts('"it\\\'s" + \'say \\"hi\\"\''), ['it\'s', 'say "hi"'], 'escapes');
  assert.deepEqual(texts('const url = "http://example.com"; // not a comment inside a string'), ['http://example.com']);
  assert.equal(literalsOf('a;\nb;\n"c"')[0].line, 3);
});

test('the rules flag each retired term and allow what is deliberately kept', () => {
  const terms = (/** @type {string} */ text, /** @type {object} */ o) => retiredIn(text, o).map((f) => f.term);
  assert.deepEqual(terms('2 callers are stale'), ['stale']);
  assert.deepEqual(terms('Tick the file'), ['tick']);
  assert.deepEqual(terms('Your ticks are kept; untick it; ticked rows'), ['tick']);
  assert.deepEqual(terms('Tier A needs TypeScript'), ['Tier A']);
  assert.deepEqual(terms('⛔ 1'), ['glyph for a state']);
  assert.deepEqual(terms('the viewed mark'), ['viewed alone']);
  assert.deepEqual(terms('Viewed on GitHub not synced'), []);
  assert.deepEqual(terms('marked it Viewed on GitHub'), []);
  assert.deepEqual(terms('state VIEWED and UNVIEWED, unviewed'), [], 'the enum and "unviewed" are not the word');
  assert.deepEqual(terms('Go to the next unreviewed change (rebind it in Keyboard Shortcuts)'), ['rebind hint']);
  assert.deepEqual(terms('Show everything (now showing only threads)'), ['state in a title']);
  assert.deepEqual(terms('changes needing attention'), ['needing attention']);
  assert.deepEqual(terms('Analyse as soon as the window opens'), []);
  assert.deepEqual(terms('Analyze the diff'), ['analyze']);
  assert.deepEqual(terms('run npm run analyze -- --mode pr'), [], 'the npm script is allowed');
  assert.deepEqual(terms('impact-tree analyze --repo x'), [], 'the CLI command is allowed');
  assert.deepEqual(terms('`impactTree.tierA.maxFiles`'), [], 'the setting key stays');
  assert.deepEqual(terms('<button data-act="tick">Mark reviewed</button>', { fragments: true }), []);
  assert.deepEqual(terms('<button data-act="tick">Tick</button>', { fragments: true }), ['tick'], 'prose next to an allowed fragment is still checked');
});

// ---- package.json --------------------------------------------------------------------

/**
 * Every text of package.json a user reads, with where it is.
 * @returns {Array<{ where: string, text: string }>}
 */
function packageTexts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  /** @type {Array<{ where: string, text: string }>} */
  const out = [];
  const add = (/** @type {string} */ where, /** @type {unknown} */ text) => { if (typeof text === 'string') out.push({ where, text }); };
  add('description', pkg.description);
  add('displayName', pkg.displayName);
  const c = pkg.contributes;
  for (const cmd of c.commands) { add(`command ${cmd.command} title`, cmd.title); add(`command ${cmd.command} category`, cmd.category); }
  for (const w of c.viewsWelcome) add(`viewsWelcome ${w.view} (${w.when})`, w.contents);
  for (const [container, views] of Object.entries(c.views)) for (const v of views) add(`view ${container}/${v.id} name`, v.name);
  for (const bar of Object.values(c.viewsContainers)) for (const b of bar) add(`viewsContainer ${b.id} title`, b.title);
  const conf = Array.isArray(c.configuration) ? c.configuration : [c.configuration];
  for (const section of conf) {
    add('configuration title', section.title);
    for (const [key, prop] of Object.entries(section.properties)) {
      add(`setting ${key} description`, prop.description);
      add(`setting ${key} markdownDescription`, prop.markdownDescription);
      add(`setting ${key} deprecationMessage`, prop.deprecationMessage);
      for (const [k, d] of (prop.enumDescriptions || []).entries()) add(`setting ${key} enumDescriptions[${k}]`, d);
      for (const [k, d] of (prop.markdownEnumDescriptions || []).entries()) add(`setting ${key} markdownEnumDescriptions[${k}]`, d);
    }
  }
  return out;
}

test('package.json: no title, description or welcome text uses a retired term', () => {
  const texts = packageTexts();
  assert.ok(texts.length > 40, `found only ${texts.length} texts; did the package.json layout change?`);
  const problems = texts.flatMap(({ where, text }) => retiredIn(text).map((f) => `${where}: "${f.match}" (${f.term}); use ${f.use}`));
  assert.deepEqual(problems, []);
});

test('package.json: toggle commands have plain titles; the icon shows the state', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const title = (/** @type {string} */ id) => pkg.contributes.commands.find((/** @type {any} */ x) => x.command === id).title;
  assert.equal(title('impactTree.filterAttention'), 'Impact Tree: Show only needs attention');
  assert.equal(title('impactTree.filterAttentionOn'), 'Impact Tree: Show all');
  assert.equal(title('impactTree.filterUnreviewed'), 'Impact Tree: Hide reviewed');
  assert.equal(title('impactTree.filterUnreviewedOn'), 'Impact Tree: Show all');
  assert.equal(title('impactTree.filterThreads'), 'Impact Tree: Show only unresolved threads');
  assert.equal(title('impactTree.filterThreadsOn'), 'Impact Tree: Show all');
  assert.equal(title('impactTree.selectMode'), 'Impact Tree: Choose what to review');
  assert.equal(title('impactTree.setCheckpoint'), 'Impact Tree: Set checkpoint now');
  assert.equal(title('impactTree.retryViewedSync'), 'Impact Tree: Retry Viewed on GitHub');
  for (const cmd of pkg.contributes.commands) {
    assert.ok(!/\(now showing|rebind/i.test(cmd.title), `${cmd.command}: ${cmd.title}`);
  }
});

test('the mode labels come from one table and the setting values are unchanged', () => {
  const { MODES, modeLabel } = require('../src/engine/analyze');
  assert.deepEqual(Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, m.label])), {
    working: 'Uncommitted (agent)', checkpoint: 'Since checkpoint', branch: 'Branch + uncommitted', pr: 'Branch vs base',
  });
  assert.equal(modeLabel('pr'), 'Branch vs base');
  assert.equal(modeLabel('something-else'), 'something-else', 'an unknown id is shown as it is');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const setting = pkg.contributes.configuration.properties['impactTree.mode'];
  assert.deepEqual(setting.enum, ['pr', 'branch', 'working', 'checkpoint']);
  for (const m of Object.values(MODES)) assert.ok(setting.description.includes(m.label), `the setting description names ${m.label}`);
  const { MODE_LABELS } = require('../src/tree-row-models');
  assert.deepEqual(MODE_LABELS, Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, m.label])));
});

// ---- README --------------------------------------------------------------------------

test('README.md: no retired term', () => {
  const text = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const problems = text.split('\n').flatMap((line, k) => retiredIn(line).map((f) => `README.md:${k + 1}: "${f.match}" (${f.term}); use ${f.use}`));
  assert.deepEqual(problems, []);
});

// ---- source modules --------------------------------------------------------------------

// The modules whose literals a user reads: the tree, Details, the pull request tab, the status
// bar, commands and quick picks, notifications, the CodeLens and the CLI. Modules that only
// write the output channel (viewed-sync, resolver-vscode, ...) are not listed.
const SOURCES = [
  'tree-row-models', 'tree-item-renderer', 'tree-provider', 'tree-grouping', 'review-tree-model', 'sources-provider',
  'detail-panel-html', 'detail-panel', 'pr-overview-html', 'pr-overview-panel', 'pr-actions', 'pr-review-data',
  'review-navigation', 'review-lens', 'review-open', 'open-review', 'commands', 'session', 'cli', 'cli-format',
  'view-state', 'path-tree', 'decorations', 'extension', 'readiness', 'review-threads', 'review-comments',
  'engine/analyze', 'engine/analyze-remote',
  'feedback-drafts', 'feedback-comments', 'feedback-comments-model', 'feedback-tree',
].map((name) => `src/${name}.js`);

test('the user-facing source modules use no retired term in their string literals', () => {
  const problems = [];
  let checked = 0;
  for (const file of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const { text, line } of literalsOf(source)) {
      if (ALLOWED_LITERALS.some((a) => a.re.test(text))) continue;
      checked++;
      for (const f of retiredIn(text, { fragments: true })) problems.push(`${file}:${line}: "${f.match}" (${f.term}); use ${f.use}`);
    }
  }
  assert.ok(checked > 500, `checked only ${checked} literals; is the extractor still working?`);
  assert.deepEqual(problems, []);
});
