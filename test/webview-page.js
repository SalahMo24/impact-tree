'use strict';
const vm = require('node:vm');

// A small DOM boundary for the generated Details script. It executes production
// message/click handlers; serialization lets integration tests inspect visible text
// separately from the original HTML document that VS Code stores.
const escapeText = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const decode = (text) => text.replace(/&quot;|&#39;|&lt;|&gt;|&amp;/g, (c) => ({ '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' })[c]);

function createPage(html, send) {
  class Element {
    constructor(attributes, textContent) { this.attributes = attributes; this.textContent = textContent; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    closest() { return this; }
  }
  const nodes = new Map();
  const matches = [
    ['.origin', /<div class="origin">([^]*?)<\/div>/],
    ['[data-act="tick"]', /<button data-act="tick"([^]*?)>([^]*?)<\/button>/],
    ['[data-review-summary]', /<div class="verdict [^"]*" data-review-summary>([^]*?)<\/div>/],
    ['[data-progress-line]', /<div class="where" data-progress-line>([^]*?)<\/div>/],
    ['[data-progress-count]', /<span data-progress-count>([^]*?)<\/span>/],
    ['[data-progress-attention]', /<span class="([^"]*)" data-progress-attention>([^]*?)<\/span>/],
    ['[data-progress-percent]', /<span class="pct" data-progress-percent>([^]*?)<\/span>/],
    ['[data-progress-meter]', /<progress([^>]*)>([^]*?)<\/progress>/],
  ];
  // Patterns that capture attributes (or a class) first and the text second.
  const attributed = new Set(['[data-act="tick"]', '[data-progress-attention]', '[data-progress-meter]']);
  for (const [selector, pattern] of matches) {
    const match = pattern.exec(html);
    if (!match) continue;
    const attributes = {};
    if (selector === '[data-progress-attention]') attributes.class = match[1];
    else if (attributed.has(selector)) {
      for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[attr[1]] = decode(attr[2]);
    }
    if (selector === '[data-act="tick"]') attributes['data-act'] = 'tick';
    nodes.set(selector, new Element(attributes, decode(match[attributed.has(selector) ? 2 : 1])));
  }
  const messages = new Map(), clicks = new Map(), sent = [];
  const script = /<script[^>]*>([^]*?)<\/script>/.exec(html)[1];
  vm.runInNewContext(script, {
    Element,
    acquireVsCodeApi: () => ({ postMessage: (message) => { sent.push(JSON.parse(JSON.stringify(message))); if (send) send(message); } }),
    window: { addEventListener: (event, handler) => messages.set(event, handler) },
    document: { querySelector: (selector) => nodes.get(selector) || null, addEventListener: (event, handler) => clicks.set(event, handler) },
  });
  return {
    sent, nodes,
    receive: (data) => messages.get('message')({ data }),
    click: (selector) => clicks.get('click')({ target: nodes.get(selector), preventDefault() {} }),
    html() {
      let visible = html;
      for (const [selector, pattern] of matches) {
        const node = nodes.get(selector);
        if (!node) continue;
        visible = visible.replace(pattern, (match) => match.replace(/>[^]*?</, `>${escapeText(node.textContent)}<`));
      }
      return visible;
    },
  };
}
module.exports = { createPage };
