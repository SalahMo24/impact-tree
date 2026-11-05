# Row locks

Writers take a row's lock with `lockRow` before they change the row. Since the lock
timeout, `lockRow` throws `LockTimeout` after `timeoutMs` (5 s by default); a writer that
can't wait should pass a shorter timeout and handle the error.
