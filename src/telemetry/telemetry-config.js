'use strict';
// Where usage events go. The PostHog project key is not in the repository: packaging writes it
// into telemetry-key.js (scripts/write-telemetry-key.js, run by `vscode:prepublish`; git ignores
// the file). A project key (phc_) can only send events, so it is safe inside the packaged
// extension; a personal key (phx_) must never be used. With no key, nothing is sent.
// `IMPACT_TREE_POSTHOG_KEY` / `IMPACT_TREE_POSTHOG_HOST` override both, for testing a build.

/** The key packaging wrote, or '' in a checkout that was never packaged. */
function packagedKey() {
  try { return String(require('./telemetry-key') || ''); } catch { return ''; }
}

module.exports = {
  key: process.env.IMPACT_TREE_POSTHOG_KEY || packagedKey(),
  host: process.env.IMPACT_TREE_POSTHOG_HOST || 'https://us.i.posthog.com',
};
