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
// A second small DOM boundary, for pages whose script finds its elements by attribute
// (`[data-el="summary"]`, `[data-act]`) and reads form state: the Pull Request tab. Every
// start tag with a `data-el` or `data-act` attribute becomes an element; a textarea's text
// is its value, an input's `checked` attribute its checked state. Timers are manual: the
// test runs them with `runTimers()`, so a debounce is exercised without waiting.
function createFormPage(html, send) {
  class Element {
    constructor(tag, attributes, text) {
      this.tagName = tag; this.attributes = attributes; this.textContent = text;
      this.value = tag === 'textarea' ? text : (attributes.value ?? '');
      this.checked = 'checked' in attributes;
    }
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    hasAttribute(name) { return name in this.attributes; }
    matches(selector) {
      const parts = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
      return parts.length > 0 && parts.every(([, name, value]) => this.hasAttribute(name) && (value === undefined || this.attributes[name] === value));
    }
    closest(selector) { return this.matches(selector) ? this : null; }
  }
  const elements = [];
  for (const match of html.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>/g)) {
    const attributes = {};
    for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attr[1]] = attr[2] === undefined ? '' : decode(attr[2]);
    if (!('data-el' in attributes) && !('data-act' in attributes)) continue;
    const tag = match[1];
    const start = match.index + match[0].length;
    // Text up to the first closing tag of the same name: exact for the leaf elements read.
    const text = tag === 'input' ? '' : decode(html.slice(start, html.indexOf(`</${tag}>`, start)).replace(/<[^>]*>/g, ''));
    elements.push(new Element(tag, attributes, text));
  }
  const listeners = { input: [], change: [], click: [], message: [] };
  const timers = new Map();
  let timerId = 0;
  const sent = [];
  const script = /<script[^>]*>([^]*?)<\/script>/.exec(html)[1];
  vm.runInNewContext(script, {
    Element,
    acquireVsCodeApi: () => ({ postMessage: (message) => { sent.push(JSON.parse(JSON.stringify(message))); if (send) send(message); } }),
    window: { addEventListener: (event, handler) => listeners[event].push(handler) },
    document: {
      querySelector: (selector) => elements.find((e) => e.matches(selector)) || null,
      addEventListener: (event, handler) => listeners[event].push(handler),
    },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  const find = (name) => {
    const found = elements.find((e) => e.attributes['data-el'] === name);
    if (!found) throw new Error(`no element data-el="${name}" on the page`);
    return found;
  };
  const fire = (event, target) => { for (const handler of listeners[event]) handler({ target, preventDefault() {} }); };
  return {
    sent,
    el: (name) => elements.find((e) => e.attributes['data-el'] === name) || null,
    all: (selector) => elements.filter((e) => e.matches(selector)),
    // The reviewer types: the value changes and an input event fires.
    type(name, text) { const target = find(name); target.value = text; fire('input', target); },
    // The reviewer ticks or unticks a checkbox.
    setChecked(name, on) { const target = find(name); target.checked = on; fire('change', target); },
    click(target) { fire('click', typeof target === 'string' ? find(target) : target); },
    receive(data) { for (const handler of listeners.message) handler({ data }); },
    pendingTimers: () => timers.size,
    runTimers() { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); },
  };
}

module.exports = { createPage, createFormPage };
