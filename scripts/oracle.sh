#!/bin/bash
# Runs a language-oracle harness script the way every oracle run must go:
#
#   scripts/oracle.sh <harness script> [args…]
#   scripts/oracle.sh test/lsp-harness/csharp-verify.js --syntactic --callers --repo <clone> --commit <sha>
#
# - Holds the test-repository lock (with-repo-lock.sh in the scratchpad folder,
#   test/lsp-harness/scratchpad.js): oracle and e2e scripts check out branches in the shared
#   test repositories, so two at once corrupt each other.
# - Puts the scratchpad's .NET SDK on PATH (csharp-tools/env.sh) when it exists, for C#.
# - Runs from the repository root, so relative paths in the arguments resolve there.
# Exit status: the script's own; 3 when the lock stayed held for 15 min; 2 on a usage error.
set -u
[ $# -ge 1 ] || { echo "usage: scripts/oracle.sh <harness script> [args…]"; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
SCRATCH="$(node -p "require('./test/lsp-harness/scratchpad').scratchpadPath()")"
LOCK="$SCRATCH/with-repo-lock.sh"
[ -f "$LOCK" ] || { echo "oracle: no with-repo-lock.sh in the scratchpad folder; the oracle runs are not set up on this machine (npm run -s local-notes)"; exit 2; }
if [ -f "$SCRATCH/csharp-tools/env.sh" ]; then
  # shellcheck disable=SC1091
  . "$SCRATCH/csharp-tools/env.sh"
fi
exec bash "$LOCK" node --max-old-space-size=8192 "$@"
