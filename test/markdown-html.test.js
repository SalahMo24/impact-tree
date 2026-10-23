'use strict';
// Markdown from GitHub as the Pull Request tab's HTML: what is rendered, including the
// raw HTML GitHub allows in a comment, and what can never come out of it (a tag or
// attribute off the allowlist, a non-http link, an inline style or handler, an image
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

test('GitHub\'s raw HTML is rendered: a template comment vanishes, details fold, kbd and sub survive, align becomes a class', () => {
  const html = renderMarkdown('<!-- Describe the change -->\nFixes it.\n\n<details open><summary>More</summary>\n\n| a |\n|---|\n| 1 |\n\n</details>\n\n<p align="center">Press <kbd>Cmd</kbd> H<sub>2</sub>O <abbr title="pull request">PR</abbr></p>\n\n<table><tr><td align="right">r</td><td align="LEFT" class="al bogus">l</td></tr></table>');
  assert.ok(!html.includes('Describe the change'), 'an HTML comment is dropped');
  assert.ok(html.startsWith('<p>Fixes it.</p>'));
  assert.ok(html.includes('<details open><summary>More</summary>\n<table>'), 'markdown inside a details block is rendered');
  assert.ok(html.includes('<p class="ac">Press <kbd>Cmd</kbd> H<sub>2</sub>O <abbr title="pull request">PR</abbr></p>'));
  assert.ok(html.includes('<td class="ar">r</td><td class="al">l</td>'), 'align is a class; an unknown class is dropped');
  assert.ok(!/\salign=/.test(html));
});

test('a tag off the allowlist is dropped and its text kept; script and style go with their text; no attribute survives but the allowed few', () => {
  const html = renderMarkdown('<div style="position:fixed" onclick="x()" id="top" data-x="1">block</div>\n\n<span style="color:red" title="t">s</span> <script>bad()</script><style>p{}</style><iframe src="https://e"></iframe><object data="x"></object><svg onload="y()"><a href="https://z">in svg</a></svg><base href="https://evil/"><meta http-equiv="refresh" content="0"><form action="https://evil"><input type="text" onfocus="z()"><button>go</button></form><textarea>t</textarea><h2 id="h" class="anything">H</h2>');
  assert.ok(html.includes('<div>block</div>'));
  assert.ok(html.includes('<span>s</span>'), 'a span keeps no attribute');
  for (const gone of ['<script', '<style', '<iframe', '<object', '<svg', '<base', '<meta', '<form', '<input', '<button', '<textarea', 'bad()', 'p{}']) assert.ok(!html.includes(gone), gone);
  assert.ok(html.includes('<a href="https://z">in svg</a>') && html.includes('go'), 'text inside a dropped tag stays');
  assert.ok(html.includes('<h2>H</h2>'), 'a heading keeps no id or class');
  assert.ok(!/<[^>]*\s(style|on\w+|id|name|target|data-\w+)=/.test(html), 'no style, handler, id, name, target or data attribute inside any tag');
});

test('a raw <a> is an anchor only with a safe target, a raw <img> is a link like a markdown image, a <picture> collapses to it', () => {
  const html = renderMarkdown('<a href="https://x/1" target="_blank" rel="noopener" name="n">ok</a> <a href="javascript:alert(1)" onclick="y()">js</a> <a href="//evil/p">rel</a> <a href=" JAVASCRIPT:x">cased</a>\n\n<p><picture><source srcset="https://x/d.png" media="(prefers-color-scheme: dark)"><img src="https://x/l.png" alt="logo" width="100" height="20"></picture> <img src="data:image/png;base64,AAAA" alt="d"> <img src=x onerror="alert(1)"></p>');
  assert.ok(html.includes('<a href="https://x/1">ok</a>'), 'target, rel and name are dropped');
  assert.ok(html.includes('<span>js</span>') && html.includes('<span>rel</span>') && html.includes('<span>cased</span>'), 'an unsafe target is text');
  assert.ok(!/href="(javascript|data|\/\/)/i.test(html));
  assert.ok(html.includes('<a href="https://x/l.png" class="img">[image: logo]</a>'), 'the picture is its image, as a link');
  assert.ok(html.includes('<span>[image: d]</span>') && html.includes('<span>[image: image]</span>'), 'an image with no safe source is its placeholder');
  assert.ok(!html.includes('<img') && !html.includes('<picture') && !html.includes('<source') && !html.includes('onerror'));
});

test('a raw <input> is only ever a disabled checkbox', () => {
  const html = renderMarkdown('<input type="checkbox" checked onchange="x()"> a <input type="checkbox" name="n"> b <input type="text" value="v"> c <input type="submit">');
  assert.ok(html.includes('<input type="checkbox" disabled checked> a <input type="checkbox" disabled> b  c '));
  assert.ok(!/type="(text|submit)"/.test(html) && !html.includes('value='));
});

test('#123 is not linked inside a raw <a>, and GitHub\'s HTML cannot add a class the tab does not know', () => {
  const html = renderMarkdown('<a href="https://x/9">see #9</a> and #10 <p class="note ac">n</p> <a href="https://x" class="ref img other">c</a> <li class="task x">i</li>', { refsBase: BASE });
  assert.ok(html.includes('<a href="https://x/9">see #9</a>') && !html.includes('issues/9'));
  assert.ok(html.includes(`<a href="${BASE}/issues/10" class="ref">#10</a>`));
  assert.ok(html.includes('<p class="ac">n</p>') && html.includes('<a href="https://x" class="ref img">c</a>') && html.includes('<li class="task">i</li>'));
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
