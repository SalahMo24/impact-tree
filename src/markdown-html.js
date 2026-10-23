// @ts-check
'use strict';
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');

// GitHub-flavoured markdown from a pull request (its description, review bodies and
// comments) as HTML for the Pull Request tab. Pure: text in, HTML out.
//
// GitHub lets a comment carry raw HTML, and real descriptions use it: a template's
// `<!-- comment -->`, a bot's `<details><summary>` fold, `<kbd>`, `<sub>`, a centred
// `<p align>` of badges. So the HTML is rendered, and the whole output then goes through
// an allowlist sanitizer (the approach GitHub itself takes), which is the one place the
// tab's safety is decided. The rules, in the order the tab's CSP (`default-src 'none'`)
// and the "no inline style or handler" rule need them:
// - Only the tags in `ALLOWED_TAGS` survive; any other tag is dropped and its text kept,
//   except `script`, `style`, `textarea` and `option`, whose text goes with them. HTML
//   comments are dropped. Nothing in the output carries a `style`, `id`, `name`, `target`
//   or `on…` attribute: each tag allows the few attributes in `ALLOWED_ATTRIBUTES` and no
//   other, and a class only from the values the tab's stylesheet knows.
// - A link is an anchor only when its target is http(s) or mailto; anything else
//   (`javascript:`, `data:`, `file:`) is left as the written text. The anchor's `href` is
//   the real URL: the editor opens links clicked in a webview itself, so the extension
//   never opens a URL the page named (the tab's `openLink` message stays reserved for a
//   check's link GitHub gave). `#123` becomes a link to that issue or pull request in the
//   same repository.
// - An image loads only from GitHub's own hosts (`IMAGE_ORIGINS`, which the tab's CSP
//   `img-src` repeats): a screenshot or attachment, an avatar, a raw file. Any other
//   image is drawn as a link reading `[image: alt]` to its source, which says what was
//   there instead of a broken glyph and lets no third party learn the tab was opened. A
//   raw `<img>` follows the same rule, and a `<picture>` collapses to its `<img>`.
// - Alignment, which markdown-it writes as `style="text-align:…"` on a table cell and
//   GitHub's HTML as `align="…"` on a cell or paragraph, is a class instead.
// - Single newlines are line breaks, as GitHub renders comments. Task-list items get a
//   disabled checkbox; a raw `<input>` can only ever be one.
//
// Work is bounded: a body longer than `MAX_MARKDOWN_CHARS` (GitHub's own limit for a
// comment) is cut there and says so, so a pathological body cannot hold the tab.

/** GitHub refuses a longer comment, so a longer body is not GitHub's; it is cut here. */
const MAX_MARKDOWN_CHARS = 65536;

/** A link target the tab lets through. Shared by markdown links and raw `<a>`/`<img>`. */
const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * Where an image may load from, as CSP sources: github.com (an attachment under
 * `/user-attachments/`, which redirects into githubusercontent.com) and GitHub's image
 * hosts (`user-images`, `private-user-images`, `avatars`, `raw`, `camo`, `objects`).
 */
const IMAGE_ORIGINS = ['https://github.com', 'https://*.githubusercontent.com'];
const IMAGE_URL = /^https:\/\/(github\.com|[a-z0-9-]+\.githubusercontent\.com)\//i;

const ALIGN_CLASS = { left: 'al', center: 'ac', right: 'ar' };

/**
 * GitHub's own list of tags a comment may carry, less the ones the tab has no use for
 * (`picture`/`source`, which collapse to the image; `tt`, `strike`, `ruby`, `bdo`, `wbr`).
 */
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'br', 'hr', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'input',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'a', 'strong', 'em', 'b', 'i', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'kbd', 'samp', 'var',
  'q', 'cite', 'abbr', 'dfn', 'small', 'span', 'time', 'details', 'summary', 'figure', 'figcaption', 'img',
];

/** Per tag, the only attributes kept. `class` values are further limited by `ALLOWED_CLASSES`. */
const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'class'],
  abbr: ['title'],
  code: ['class'],
  details: ['open'],
  div: ['class'],
  img: ['src', 'alt', 'width', 'height'],
  input: ['type', 'disabled', 'checked'],
  li: ['class'],
  ol: ['start'],
  p: ['class'],
  td: ['class'],
  th: ['class'],
};

const ALIGN_CLASSES = ['al', 'ac', 'ar'];
const ALLOWED_CLASSES = {
  a: ['img', 'ref'],
  code: [/^language-[\w+.#-]{1,40}$/],
  div: ALIGN_CLASSES,
  li: ['task'],
  p: ALIGN_CLASSES,
  td: ALIGN_CLASSES,
  th: ALIGN_CLASSES,
};

/**
 * An image: the element when GitHub hosts it (its size kept when given in pixels), a link
 * reading `[image: alt]` for another safe source, plain text for an unsafe one.
 * @param {Record<string, string>} attribs @returns {sanitizeHtml.Tag}
 */
const imageOf = (attribs) => {
  const src = String(attribs.src || '').trim();
  const alt = String(attribs.alt || '').trim();
  if (IMAGE_URL.test(src)) {
    /** @type {Record<string, string>} */
    const out = { src, alt };
    for (const side of ['width', 'height']) if (/^\d{1,4}$/.test(String(attribs[side] || ''))) out[side] = String(attribs[side]);
    return { tagName: 'img', attribs: out };
  }
  const text = `[image: ${alt || 'image'}]`;
  return SAFE_URL.test(src) ? { tagName: 'a', attribs: { href: src, class: 'img' }, text } : { tagName: 'span', attribs: {}, text };
};

/** An `align="…"` attribute as the matching class; the attribute itself never survives. */
/** @type {sanitizeHtml.Transformer} */
const alignAsClass = (tagName, attribs) => {
  const cls = ALIGN_CLASS[/** @type {keyof typeof ALIGN_CLASS} */ (String(attribs.align || '').toLowerCase())];
  const out = { ...attribs };
  delete out.align;
  if (cls) out.class = [...new Set(`${out.class || ''} ${cls}`.split(/\s+/).filter(Boolean))].join(' ');
  return { tagName, attribs: out };
};

/** @type {sanitizeHtml.IOptions} */
const SANITIZE = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedClasses: ALLOWED_CLASSES,
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  allowProtocolRelative: false,
  parseStyleAttributes: false,
  exclusiveFilter: (frame) => frame.tag === 'input' && frame.attribs.type !== 'checkbox',
  transformTags: {
    // A link whose target is not safe is its text, not an anchor without a target.
    a: (tagName, attribs) => (SAFE_URL.test(String(attribs.href || '').trim()) ? { tagName, attribs } : { tagName: 'span', attribs: {} }),
    img: (tagName, attribs) => imageOf(attribs),
    // A checkbox is always disabled; any other kind of input is dropped (`exclusiveFilter`).
    input: (tagName, attribs) => ({ tagName, attribs: { type: String(attribs.type || '').toLowerCase(), disabled: '', ...('checked' in attribs ? { checked: '' } : {}) } }),
    p: alignAsClass,
    div: alignAsClass,
    td: alignAsClass,
    th: alignAsClass,
  },
};

/**
 * The renderer, configured once. `env.refsBase` (per render) is the repository URL that
 * `#123` links against, or null for none.
 */
const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });
md.validateLink = (/** @type {string} */ url) => SAFE_URL.test(url.trim());

// A table cell's alignment as a class, never an inline style.
/** @type {import('markdown-it').RendererRule} */
const alignedCell = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const style = token.attrGet('style');
  if (style !== null) {
    token.attrs = (token.attrs || []).filter(([name]) => name !== 'style');
    const m = /^text-align:(left|center|right)$/.exec(String(style));
    if (m) token.attrJoin('class', ALIGN_CLASS[/** @type {keyof typeof ALIGN_CLASS} */ (m[1])]);
  }
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.td_open = alignedCell;
md.renderer.rules.th_open = alignedCell;

// `- [ ] text` and `- [x] text`: a disabled checkbox in front of the item's text.
md.core.ruler.push('task_lists', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].type !== 'list_item_open' || tokens[i + 1].type !== 'paragraph_open' || tokens[i + 2].type !== 'inline') continue;
    const inline = tokens[i + 2];
    const first = inline.children ? inline.children[0] : null;
    if (!inline.children || !first || first.type !== 'text') continue;
    const m = /^\[([ xX])\]\s+/.exec(first.content);
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    inline.children.unshift(box);
    tokens[i].attrJoin('class', 'task');
  }
});

// `#123` in text (not inside a link, markdown or raw, or code) as a link to that issue or
// pull request.
md.core.ruler.push('issue_refs', (state) => {
  const base = state.env && typeof state.env.refsBase === 'string' ? state.env.refsBase : null;
  if (!base) return;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    /** @type {import('markdown-it').Token[]} */
    const out = [];
    let inLink = 0;
    for (const child of block.children) {
      if (child.type === 'link_open' || (child.type === 'html_inline' && /^<a[\s>]/i.test(child.content))) inLink++;
      if (child.type === 'link_close' || (child.type === 'html_inline' && /^<\/a\s*>/i.test(child.content))) inLink--;
      if (child.type !== 'text' || inLink > 0 || !/#\d/.test(child.content)) { out.push(child); continue; }
      let last = 0;
      for (const m of child.content.matchAll(/(^|[^\w&/#])#(\d{1,9})(?![\w#])/g)) {
        const at = /** @type {number} */ (m.index) + m[1].length;
        if (at > last) out.push(textToken(state, child.content.slice(last, at)));
        const open = new state.Token('link_open', 'a', 1);
        open.attrSet('href', `${base}/issues/${m[2]}`);
        open.attrJoin('class', 'ref');
        out.push(open, textToken(state, `#${m[2]}`), new state.Token('link_close', 'a', -1));
        last = at + 1 + m[2].length;
      }
      if (last < child.content.length) out.push(textToken(state, child.content.slice(last)));
    }
    block.children = out;
  }
});

/** @param {import('markdown-it').StateCore} state @param {string} content @returns {import('markdown-it').Token} */
function textToken(state, content) {
  const t = new state.Token('text', '', 0);
  t.content = content;
  return t;
}

/**
 * The sanitizer's output with the void tags written as `<br>`, not `<br />`, so the HTML
 * reads as markdown-it's and the tab's. Attribute values are escaped by the sanitizer, so
 * ` />` can only end a tag.
 * @param {string} html @returns {string}
 */
const plainVoidTags = (html) => html.replace(/<(br|hr|input|img)(\s[^<>]*)? \/>/g, '<$1$2>');

/**
 * Markdown as HTML, safe for the tab (see the header).
 * @param {string} text GitHub-flavoured markdown, possibly with GitHub's raw HTML.
 * @param {{ refsBase?: string|null }} [opts] `refsBase`: the repository's URL
 *   (`https://github.com/owner/name`) that `#123` links against; none by default.
 * @returns {string} HTML; empty for blank text.
 */
function renderMarkdown(text, { refsBase = null } = {}) {
  const whole = String(text);
  const cut = whole.length > MAX_MARKDOWN_CHARS;
  // Trimmed: a dropped HTML comment at the top would otherwise leave a blank line.
  const html = plainVoidTags(sanitizeHtml(md.render(cut ? whole.slice(0, MAX_MARKDOWN_CHARS) : whole, { refsBase }), SANITIZE)).trimStart();
  return cut ? `${html}<p class="note">… the rest of this text (${whole.length - MAX_MARKDOWN_CHARS} more characters) is not shown.</p>` : html;
}

module.exports = { renderMarkdown, MAX_MARKDOWN_CHARS, ALLOWED_TAGS, IMAGE_ORIGINS };
