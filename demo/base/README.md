# Impact Tree demo

A tiny row store with one change on the `demo/lock-timeout` branch, made by Impact Tree's
**Try the demo** command. Nothing here is real code; delete the folder when you're done.

The change: `lockRow` gets a timeout and throws `LockTimeout` when it runs out. Open the
**Impact Tree** view in the activity bar and see which callers were left behind.
