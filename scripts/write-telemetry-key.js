'use strict';
// Runs before `vsce package` (the `vscode:prepublish` script). Writes the PostHog project key
// into src/telemetry/telemetry-key.js, which git ignores, so the key is in the packaged
// extension but never in the repository.
//
// The key comes from IMPACT_TREE_POSTHOG_KEY in the environment, else from .env at the repo
// root. Packaging stops when there is no key, so a release never ships without telemetry by
// mistake; set IMPACT_TREE_NO_TELEMETRY_KEY=1 to package without one on purpose.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'telemetry', 'telemetry-key.js');

/** The value of IMPACT_TREE_POSTHOG_KEY in .env, or ''. */
function keyFromDotEnv() {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; }
  const m = /^\s*IMPACT_TREE_POSTHOG_KEY\s*=\s*["']?([^"'\s#]*)/m.exec(text);
  return m ? m[1] : '';
}

const key = process.env.IMPACT_TREE_POSTHOG_KEY || keyFromDotEnv();

if (!key) {
  if (process.env.IMPACT_TREE_NO_TELEMETRY_KEY === '1') {
    fs.writeFileSync(OUT, "'use strict';\n// Written by scripts/write-telemetry-key.js. Packaged without a key: nothing is sent.\nmodule.exports = '';\n");
    console.log('telemetry key: none (IMPACT_TREE_NO_TELEMETRY_KEY=1); this build sends no telemetry');
    process.exit(0);
  }
  console.error('telemetry key: IMPACT_TREE_POSTHOG_KEY is not set and .env has none. Add it to .env, '
    + 'or set IMPACT_TREE_NO_TELEMETRY_KEY=1 to package without telemetry.');
  process.exit(1);
}
// Only a project key may ship: it can send events and nothing else. A personal key (phx_)
// can read or change the PostHog project.
if (!/^phc_[A-Za-z0-9]{20,}$/.test(key)) {
  console.error('telemetry key: not a PostHog project key (it must start with phc_). A personal key (phx_) must never ship.');
  process.exit(1);
}
fs.writeFileSync(OUT, `'use strict';\n// Written by scripts/write-telemetry-key.js before packaging; git ignores this file.\nmodule.exports = ${JSON.stringify(key)};\n`);
console.log(`telemetry key: written (${key.slice(0, 4)}…, ${key.length} characters)`);
