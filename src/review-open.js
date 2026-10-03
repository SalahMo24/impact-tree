'use strict';

// What clicking a caller should open.
//
// Tier A has the PR's text and nothing else. A file that changed anywhere — including
// a caller edited on some other line than the call — has to diff that text. Opening
// the worktree file instead shows the branch you happen to have checked out, which
// is not the pull request, so the edit is invisible.
// A caller in a file the PR does not touch has no fetched text; a diff of it would
// be two empty panes, so that one stays a plain editor.
function callerOpen({ tierA, rel, baseRel, status, absPath, fileChanged, always, baseSha, prNumber, headSha }) {
  const showDiff = tierA
    ? !!(rel && fileChanged)
    : !!(rel && (always || fileChanged));
  if (!showDiff) return { kind: 'editor', uri: { scheme: 'file', path: absPath } };
  const prSide = (side) => ({
    scheme: 'impacttree-pr', path: rel,
    query: require('./pr-documents').prQuery({ prNumber, headSha, base: { sha: baseSha } }, side, { path: rel, basePath: baseRel, status }),
  });
  const right = tierA
    ? prSide('head')
    : { scheme: 'file', path: absPath };
  const left = tierA
    ? prSide('base')
    : { scheme: 'impacttree-base', path: baseRel || rel, query: String(baseSha || '') };
  return {
    kind: 'diff',
    left,
    right,
    rhsName: tierA ? `PR #${prNumber}` : 'working',
  };
}

module.exports = { callerOpen };
