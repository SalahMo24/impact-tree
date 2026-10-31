'use strict';
// Where usage events go. A PostHog project key can only send events, never read them, so it
// is safe to ship in the extension (only `phc_` project keys; never a `phx_` personal key).
// With no key, nothing is sent (events are only logged).
// `IMPACT_TREE_POSTHOG_KEY` / `IMPACT_TREE_POSTHOG_HOST` override both, for testing a build.

module.exports = {
  key: process.env.IMPACT_TREE_POSTHOG_KEY || 'phc_n4vGjTrBPJ4PEHXHLS2cLRNTR2ytoGA4TtZM8qytbwfb',
  host: process.env.IMPACT_TREE_POSTHOG_HOST || 'https://us.i.posthog.com',
};
