// @ts-check
'use strict';
const MarkdownIt = require('markdown-it');

// GitHub-flavoured markdown from a pull request (its description, review bodies and
// comments) as HTML for the Pull Request tab. Pure: text in, HTML out.
//
// Safety, in the order the tab's CSP (`default-src 'none'`) and the "no inline style or
// handler" rule need:
// - Raw HTML in the markdown is never passed through (`html: false`): it is shown as text,
//   so `<img onerror>` in a comment is six escaped characters, not an element.
// - A link is an anchor only when its target is http(s) or mailto; anything else
//   (`javascript:`, `data:`, `file:`) is left as the written text. The anchor's `href` is
//   the real URL: the editor opens links clicked in a webview itself, so the extension
//   never opens a URL the page named (the tab's `openLink` message stays reserved for a
//   check's link GitHub gave). `#123` becomes a link to that issue or pull request in the
//   same repository.
// - An image cannot load (no `img-src`), so it is drawn as a link reading `[image: alt]`
//   to its source, which says what was there instead of a broken glyph.
// - A table's column alignment, which markdown-it writes as `style="text-align:…"`, is a
//   class instead; nothing else in the output carries a `style` or `on…` attribute.
// - Single newlines are line breaks, as GitHub renders comments. Task-list items get a
//   disabled checkbox.
//
// Work is bounded: a body longer than `MAX_MARKDOWN_CHARS` (GitHub's own limit for a
// comment) is cut there and says so, so a pathological body cannot hold the tab.

/** GitHub refuses a longer comment, so a longer body is not GitHub's; it is cut here. */
const MAX_MARKDOWN_CHARS = 65536;

const ALIGN_CLASS = { 'text-align:left': 'al', 'text-align:center': 'ac', 'text-align:right': 'ar' };

/** @param {string} value @returns {string} */
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/**
 * The renderer, configured once. `env.refsBase` (per render) is the repository URL that
 * `#123` links against, or null for none.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.validateLink = (/** @type {string} */ url) => /^(https?:|mailto:)/i.test(url.trim());

// An image as a link to it, since the page may not load images.
/** @type {import('markdown-it').RendererRule} */
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = String(token.attrGet('src') || '');
  const alt = self.renderInlineAsText(token.children || [], options, env).trim() || 'image';
  return `<a href="${escapeHtml(src)}" class="img">[image: ${escapeHtml(alt)}]</a>`;
};

// A table cell's alignment as a class, never an inline style.
/** @type {import('markdown-it').RendererRule} */
const alignedCell = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const style = token.attrGet('style');
  if (style !== null) {
    token.attrs = (token.attrs || []).filter(([name]) => name !== 'style');
    const cls = ALIGN_CLASS[/** @type {keyof typeof ALIGN_CLASS} */ (style)];
    if (cls) token.attrJoin('class', cls);
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

// `#123` in text (not inside a link or code) as a link to that issue or pull request.
md.core.ruler.push('issue_refs', (state) => {
  const base = state.env && typeof state.env.refsBase === 'string' ? state.env.refsBase : null;
  if (!base) return;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    /** @type {import('markdown-it').Token[]} */
    const out = [];
    let inLink = 0;
    for (const child of block.children) {
      if (child.type === 'link_open') inLink++;
      if (child.type === 'link_close') inLink--;
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
 * Markdown as HTML, safe for the tab (see the header).
 * @param {string} text GitHub-flavoured markdown.
 * @param {{ refsBase?: string|null }} [opts] `refsBase`: the repository's URL
 *   (`https://github.com/owner/name`) that `#123` links against; none by default.
 * @returns {string} HTML; empty for blank text.
 */
function renderMarkdown(text, { refsBase = null } = {}) {
  const whole = String(text);
  const cut = whole.length > MAX_MARKDOWN_CHARS;
  const html = md.render(cut ? whole.slice(0, MAX_MARKDOWN_CHARS) : whole, { refsBase });
  return cut ? `${html}<p class="note">… the rest of this text (${whole.length - MAX_MARKDOWN_CHARS} more characters) is not shown.</p>` : html;
}

module.exports = { renderMarkdown, MAX_MARKDOWN_CHARS };
