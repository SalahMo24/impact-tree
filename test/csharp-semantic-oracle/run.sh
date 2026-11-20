#!/bin/bash
# Semantic oracle, cached by commit and tool hash (Part C, C0a-2). Builds the oracle into
# <tools>/oracle-semantic/ when its source changed, then writes
# <tools>/cache/semantic-<repo>-<sha12>-<toolhash>.json unless it exists, and prints its path.
# The caller holds the heavy-run lock (with-repo-lock.sh); the repository must be restored.
# usage: bash run.sh <repo> <solution|project> [name]   (name: the cache file's repo name,
#        default the folder's basename; env: CSHARP_TOOLS, default the scratchpad's)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$1" && pwd)"; entry="$2"; name="${3:-$(basename "$repo")}"
tools="${CSHARP_TOOLS:-$HOME/Projects/impact-tree-scratchpad/csharp-tools}"
. "$tools/env.sh"
srcs=("$here/Program.cs" "$here/SemanticOracle.csproj" "$here/../csharp-syntax-oracle/Program.cs")
hash="$(cat "${srcs[@]}" | shasum -a 256 | cut -c1-12)"
sha="$(git -C "$repo" rev-parse HEAD | cut -c1-12)"
if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
  echo "run.sh: $repo has uncommitted changes; the cache is by commit" >&2; exit 2
fi
out="$tools/cache/semantic-$name-$sha-$hash.json"
if [ -f "$out" ]; then echo "$out"; exit 0; fi
dir="$tools/oracle-semantic"
if [ "$(cat "$dir/out/.toolhash" 2>/dev/null)" != "$hash" ]; then
  mkdir -p "$dir/src/csharp-semantic-oracle" "$dir/src/csharp-syntax-oracle"
  cp "$here/Program.cs" "$here/SemanticOracle.csproj" "$dir/src/csharp-semantic-oracle/"
  cp "$here/../csharp-syntax-oracle/Program.cs" "$dir/src/csharp-syntax-oracle/"
  dotnet build "$dir/src/csharp-semantic-oracle/SemanticOracle.csproj" -c Release -o "$dir/out" -nologo -v q >&2
  echo "$hash" > "$dir/out/.toolhash"
fi
mkdir -p "$tools/cache"
dotnet "$dir/out/SemanticOracle.dll" "$repo" "$entry" "$out.tmp" >&2
mv "$out.tmp" "$out"
echo "$out"
