'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const vscode = require('./vscode-stub');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { createOpenReview } = require('../src/open-review');
const { createPrDocuments } = require('../src/pr-documents');
const { registerContentProviders } = require('../src/content-providers');

test('docs/config-only previews reopen renamed base files at their old paths', async () => {
  for (const renamed of ['README.md', 'config.json']) {
    const oldPath = `old/${renamed}`, newPath = `new/${renamed}`;
    const requests = [];
    const gh = {
      isSignedIn: () => true,
      listPullRequestFiles: async () => ({ files: [
        { path: newPath, oldPath, status: 'renamed', patch: null },
        { path: 'added.md', status: 'added', patch: null },
        { path: 'deleted.md', status: 'removed', patch: null },
      ] }),
      fileAtRef: async (_, file, ref) => {
        requests.push({ file, ref });
        if (ref === 'merge' && file === oldPath) return 'old content';
        if (ref === 'head' && file === newPath) return 'new content';
        return null;
      },
    };
    const slug = { owner: 'o', repo: 'r' };
    const result = await analyzeRemote({ ts: require('typescript'), gh, slug,
      pr: { number: 7, headSha: 'head', mergeBaseSha: 'merge' }, repoRoot: '/remote' });
    assert.deepEqual(requests, [], 'non-source files are fetched only when opened');
    const documents = createPrDocuments();
    documents.add(result);
    const providers = new Map(), diffs = [];
    const editor = { ...vscode,
      workspace: { registerTextDocumentContentProvider: (scheme, provider) => {
        providers.set(scheme, provider); return { dispose() {} };
      } },
      commands: { executeCommand: async (command, left, right) => {
        assert.equal(command, 'vscode.diff'); diffs.push([left, right]);
      } },
      window: { showWarningMessage: (message) => assert.fail(message) },
    };
    registerContentProviders(editor, { prDocuments: documents, gh, repoSlug: () => slug, repoRoot: () => '/remote' });
    const open = createOpenReview(editor, { isTierA: () => true, repoRoot: () => '/remote',
      state: { result, changedPaths: new Set(result.changedPaths) } });
    await open.openFile({ relPath: newPath, status: 'renamed' });
    await open.openFile({ relPath: 'added.md', status: 'added' });
    await open.openFile({ relPath: 'deleted.md', status: 'deleted' });
    documents.add({ prNumber: 99, headSha: 'later', base: { sha: 'later-base' }, texts: new Map() });
    const read = (uri) => providers.get('impacttree-pr').provideTextDocumentContent(uri);
    assert.equal(await read(diffs[0][0]), 'old content', `${path.extname(renamed)} base reads its pre-rename path`);
    assert.equal(await read(diffs[0][1]), 'new content');
    assert.equal(await read(diffs[1][0]), '', 'added files have no base side');
    assert.equal(await read(diffs[2][1]), '', 'deleted files have no head side');
    assert.deepEqual(requests, [{ file: oldPath, ref: 'merge' }, { file: newPath, ref: 'head' }]);
  }
});
