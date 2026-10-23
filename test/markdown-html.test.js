'use strict';
// Markdown from GitHub as the Pull Request tab's HTML: what is rendered, and what can
// never come out of it (GitHub's own HTML, a non-http link, an inline style, an image
// element). Through the public function only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, MAX_MARKDOWN_CHARS } = require('../src/markdown-html');

const BASE = 'https://github.com/o/r';

test('GitHub-flavoured markdown: headings, emphasis, code, lists, quotes, rules, and newlines as line breaks', () => {
  const html = renderMarkdown('# T\n\nSome **bold** and _it_ and `code`.\nnext line\n\n- a\n- b\n\n1. one\n\n> quoted\n\n---\n\n```js\nconst x = 1;\n```\n\n~~gone~~');
  assert.ok(html.includes('<h1>T</h1>'));
  assert.ok(html.includes('<strong>bold</strong>') && html.includes('<em>it</em>') && html.includes('<code>code</code>'));
  assert.ok(html.includes('.<br>\nnext line'), 'a single newline is a line break, as GitHub draws comments');
  assert.ok(html.includes('<ul>\n<li>a</li>\n<li>b</li>\n</ul>') && html.includes('<ol>\n<li>one</li>\n</ol>'));
  assert.ok(html.includes('<blockquote>') && html.includes('<hr>'));
  assert.ok(html.includes('<pre><code class="language-js">const x = 1;\n</code></pre>'));
  assert.ok(html.includes('<s>gone</s>'));
});

test('raw HTML is shown as text, never passed through', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> and <script>bad()</script>\n\n<div style="color:red" onclick="x()">block</div>');
  assert.ok(!html.includes('<img') && !html.includes('<script') && !html.includes('<div'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!/<[^>]*\sstyle=/.test(html) && !/<[^>]*\son\w+=/.test(html), 'no attribute inside a tag; the words survive only as escaped text');
});

test('links: http, https and mailto become anchors; javascript, data, file and vbscript stay text; bare URLs are linked', () => {
  const html = renderMarkdown('[a](https://x/y "T") [b](http://x) [c](mailto:me@x.y) [d](javascript:alert(1)) [e](data:text/html,hi) [f](file:///etc) [g](vbscript:x) see https://auto.link/p?q=1');
  assert.ok(html.includes('<a href="https://x/y" title="T">a</a>') && html.includes('<a href="http://x">b</a>') && html.includes('<a href="mailto:me@x.y">c</a>'));
  for (const bad of ['javascript:', 'data:', 'file:', 'vbscript:']) assert.ok(!html.includes(`href="${bad}`), bad);
  assert.ok(html.includes('[d](javascript:alert(1))'), 'the written text stays');
  assert.ok(html.includes('<a href="https://auto.link/p?q=1">https://auto.link/p?q=1</a>'));
});

test('an image is a link to it that names the alt text; a data: image is text', () => {
  const html = renderMarkdown('![shot](https://img/a.png) ![](https://img/b.png) ![x](data:image/png;base64,AAAA)');
  assert.ok(html.includes('<a href="https://img/a.png" class="img">[image: shot]</a>'));
  assert.ok(html.includes('<a href="https://img/b.png" class="img">[image: image]</a>'));
  assert.ok(!html.includes('<img') && html.includes('![x](data:image/png;base64,AAAA)'));
});

test('#123 links into the repository given, not inside a link or code, not as part of a word; none without a repository', () => {
  const text = 'Fixes #24098 (#17063). Not C#12, not &#39;, not [#5](https://x/5), not `#6`, not https://x/a#7, but #8.';
  const html = renderMarkdown(text, { refsBase: BASE });
  assert.ok(html.includes(`<a href="${BASE}/issues/24098" class="ref">#24098</a>`));
  assert.ok(html.includes(`(<a href="${BASE}/issues/17063" class="ref">#17063</a>)`));
  assert.ok(html.includes(`but <a href="${BASE}/issues/8" class="ref">#8</a>.`));
  assert.ok(html.includes('C#12') && !html.includes('issues/12'), 'not inside a word');
  assert.ok(!html.includes('issues/39'), 'not an entity');
  assert.ok(html.includes('<a href="https://x/5">#5</a>') && !html.includes('issues/5'), 'not inside a link');
  assert.ok(html.includes('<code>#6</code>') && !html.includes('issues/6'), 'not in code');
  assert.ok(!html.includes('issues/7'), 'not a URL fragment');
  assert.ok(!renderMarkdown(text).includes('issues/'), 'no repository, no links');
  assert.ok(!renderMarkdown('#99999999999', { refsBase: BASE }).includes('issues/'), 'not an absurd number');
});

test('task lists get a disabled checkbox, ticked for [x]', () => {
  const html = renderMarkdown('- [ ] open\n- [x] done\n- [X] also\n- [y] not a box\n- plain');
  assert.ok(html.includes('<li class="task"><input type="checkbox" disabled> open</li>'));
  assert.ok(html.includes('<li class="task"><input type="checkbox" disabled checked> done</li>'));
  assert.ok(html.includes('<li class="task"><input type="checkbox" disabled checked> also</li>'));
  assert.ok(html.includes('<li>[y] not a box</li>') && html.includes('<li>plain</li>'));
});

test('a table\'s column alignment is a class, never an inline style', () => {
  const html = renderMarkdown('| l | c | r | n |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |');
  assert.ok(html.includes('<th class="al">l</th>') && html.includes('<th class="ac">c</th>') && html.includes('<th class="ar">r</th>') && html.includes('<th>n</th>'));
  assert.ok(html.includes('<td class="ar">3</td>') && html.includes('<td>4</td>'));
  assert.ok(!/\sstyle=/.test(html));
});

test('blank text renders nothing; a body over GitHub\'s limit is cut there and says so', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('  \n\t'), '');
  const long = 'a'.repeat(MAX_MARKDOWN_CHARS + 10);
  const html = renderMarkdown(long);
  assert.ok(html.endsWith('<p class="note">… the rest of this text (10 more characters) is not shown.</p>'));
  assert.ok(html.length < MAX_MARKDOWN_CHARS + 200, 'the output is bounded by the input limit');
  assert.ok(!renderMarkdown('a'.repeat(MAX_MARKDOWN_CHARS)).includes('is not shown'), 'exactly the limit is whole');
});
