# Impact Tree demo

A tiny row store with one change on the `demo/lock-timeout` branch, built by
`scripts/demo-repo.js` for tests and for recording the README's screenshots. Nothing here
is real code.

The change: `lockRow` gets a timeout and throws `LockTimeout` when it runs out. Open the
**Impact Tree** view in the activity bar and see which callers were left behind.
