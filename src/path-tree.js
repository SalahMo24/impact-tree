// @ts-check
'use strict';
// A repo-relative path drawn as a small folder tree for a file row's tooltip:
//
//   src/
//   └─ engine/resolvers/ts/
//      └─ cache/
//         └─ program-cache.js
//
// Up to `maxFolders` folders get a line each. Deeper paths keep the top folder and the
// file's own folder on their own lines and merge the folders between onto one line, so
// the tree is never taller than four lines. A merged line longer than `maxMergedChars`
// loses its middle segments to `…`; the caller then shows the full path as well.

/**
 * The folders between the top folder and the parent, as one line that fits `max` chars:
 * whole segments are kept from both ends, alternately, and `…` stands for the rest.
 * The first and last segments are always kept.
 * @param {string[]} folders
 * @param {number} max
 * @returns {{ text: string, truncated: boolean }}
 */
function mergeFolders(folders, max) {
  const whole = `${folders.join('/')}/`;
  if (whole.length <= max || folders.length <= 2) return { text: whole, truncated: false };
  const head = [folders[0]];
  const tail = [folders[folders.length - 1]];
  const fits = () => `${[...head, '…', ...tail].join('/')}/`.length <= max;
  let i = 1;
  let j = folders.length - 2;
  for (let fromTail = true; i <= j; fromTail = !fromTail) {
    if (fromTail) tail.unshift(folders[j--]);
    else head.push(folders[i++]);
    if (!fits()) {
      if (fromTail) tail.shift(); else head.pop();
      break;
    }
  }
  return { text: `${[...head, '…', ...tail].join('/')}/`, truncated: true };
}

/**
 * The lines of a path's folder tree, last line the file name. `truncated` is true when
 * a folder name was replaced by `…`, so the tree alone no longer gives the full path.
 * @param {string} relPath A repo-relative path; `/` or `\` separated.
 * @param {{ maxFolders?: number, maxMergedChars?: number }} [opts]
 * @returns {{ lines: string[], truncated: boolean }}
 */
function pathTreeLines(relPath, { maxFolders = 3, maxMergedChars = 32 } = {}) {
  const parts = String(relPath).split(/[\\/]/).filter(Boolean);
  const file = parts.pop() || String(relPath);
  let truncated = false;
  /** @type {string[]} */
  let nodes = parts.map((f) => `${f}/`);
  if (parts.length > maxFolders) {
    const middle = mergeFolders(parts.slice(1, -1), maxMergedChars);
    truncated = middle.truncated;
    nodes = [`${parts[0]}/`, middle.text, `${parts[parts.length - 1]}/`];
  }
  nodes.push(file);
  const lines = nodes.map((node, depth) => (depth === 0 ? node : `${'   '.repeat(depth - 1)}└─ ${node}`));
  return { lines, truncated };
}

/**
 * The folder tree as tooltip Markdown: a code block, so it lines up in any font, then the
 * full path in code when the tree had to shorten it.
 * @param {string} relPath
 * @returns {string[]} Markdown lines.
 */
function pathTreeMarkdown(relPath) {
  const { lines, truncated } = pathTreeLines(relPath);
  // A fence longer than any backtick run in the path, so a name cannot close it.
  const runs = String(relPath).match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return [fence, ...lines, fence, ...(truncated ? ['', inlineCode(relPath)] : [])];
}

/**
 * @param {string} text
 * @returns {string}
 */
function inlineCode(text) {
  const runs = text.match(/`+/g) || [];
  const ticks = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  return ticks.length > 1 ? `${ticks} ${text} ${ticks}` : `\`${text}\``;
}

module.exports = { pathTreeLines, pathTreeMarkdown };
