'use strict';
// scripts/drive.js's guards (C0 review, finding 18): --extensions-dir only under the
// repository's .vscode-test/ or the scratchpad, never an editor's own extensions folder; the
// safety settings win over --settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkExtensionsDir, runSettings, SAFETY_SETTINGS } = require('../scripts/drive');

const ROOT = path.join(__dirname, '..');

test('--extensions-dir: allowed under .vscode-test/ and the scratchpad, refused elsewhere and for editor folders', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-drive-home-')));
  const saved = process.env.IMPACT_TREE_SCRATCHPAD;
  const scratch = path.join(home, 'scratch');
  const inRepo = path.join(ROOT, '.vscode-test', `it-drive-guard-${process.pid}`);
  try {
    process.env.IMPACT_TREE_SCRATCHPAD = scratch;
    for (const d of ['.vscode/extensions', '.cursor/extensions', '.vscode-insiders/extensions', 'elsewhere', 'scratch/csharp-tools/vscode-ext']) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
    }
    fs.mkdirSync(inRepo, { recursive: true });
    assert.equal(checkExtensionsDir(inRepo, home), fs.realpathSync(inRepo));
    const ok = path.join(scratch, 'csharp-tools', 'vscode-ext');
    assert.equal(checkExtensionsDir(ok, home), ok);
    for (const d of ['.vscode/extensions', '.cursor/extensions', '.vscode-insiders/extensions']) {
      assert.throws(() => checkExtensionsDir(path.join(home, d), home), /editor's own extensions folder/, d);
    }
    assert.throws(() => checkExtensionsDir(path.join(home, 'elsewhere'), home), /must be a folder inside/);
    assert.throws(() => checkExtensionsDir(scratch, home), /must be a folder inside/, 'the scratchpad root itself');
    assert.throws(() => checkExtensionsDir(path.join(ROOT, '.vscode-test'), home), /must be a folder inside/, '.vscode-test itself');
    // A symlink in an allowed root that points at an editor's folder is refused.
    const link = path.join(scratch, 'link-to-editor');
    fs.symlinkSync(path.join(home, '.vscode', 'extensions'), link);
    assert.throws(() => checkExtensionsDir(link, home), /editor's own extensions folder/);
    // Another IMPACT_TREE_SCRATCHPAD moves the allowed root.
    process.env.IMPACT_TREE_SCRATCHPAD = path.join(home, 'elsewhere');
    fs.mkdirSync(path.join(home, 'elsewhere', 'ext'));
    assert.equal(checkExtensionsDir(path.join(home, 'elsewhere', 'ext'), home), path.join(home, 'elsewhere', 'ext'));
  } finally {
    if (saved === undefined) delete process.env.IMPACT_TREE_SCRATCHPAD; else process.env.IMPACT_TREE_SCRATCHPAD = saved;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(inRepo, { recursive: true, force: true });
  }
});

test('--settings adds and overrides, except the safety settings', () => {
  const s = runSettings({
    'dotnet.server.path': '/x', 'workbench.colorTheme': 'Default Light Modern',
    'telemetry.telemetryLevel': 'all', 'update.mode': 'default', 'extensions.autoUpdate': true,
    'extensions.autoCheckUpdates': true, 'security.workspace.trust.enabled': true,
  });
  assert.equal(s['dotnet.server.path'], '/x');
  assert.equal(s['workbench.colorTheme'], 'Default Light Modern');
  for (const [k, v] of Object.entries(SAFETY_SETTINGS)) assert.equal(s[k], v, k);
  assert.deepEqual(Object.keys(SAFETY_SETTINGS).sort(), ['extensions.autoCheckUpdates', 'extensions.autoUpdate', 'security.workspace.trust.enabled', 'telemetry.telemetryLevel', 'update.mode']);
  assert.equal(runSettings(null)['telemetry.telemetryLevel'], 'off');
});
