'use strict';
// `npm run package`: builds the .vsix, then deletes src/telemetry/telemetry-key.js.
// `vsce package` runs `vscode:prepublish`, which writes the PostHog key into that file so it
// ships in the .vsix. Left behind, the key would make a source install of this checkout send
// the developer's own usage. Extra arguments go to `vsce package` (for example `-o out.vsix`).
// Publish the built file with `vsce publish --packagePath` and `ovsx publish`, which do not
// run the prepublish step again.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const KEY_FILE = path.join(ROOT, 'src', 'telemetry', 'telemetry-key.js');

let status = 1;
try {
  const run = spawnSync('npx', ['-y', '@vscode/vsce@4.1.0', 'package', ...process.argv.slice(2)],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  status = run.status ?? 1;
} finally {
  fs.rmSync(KEY_FILE, { force: true });
  console.log('telemetry key: removed from the checkout');
}
process.exit(status);
