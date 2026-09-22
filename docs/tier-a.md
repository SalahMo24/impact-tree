# Tier A — building the impact tree without a checkout

Impact Tree has two ways to analyse a pull request.

**Tier B** checks the branch out and drives the editor's language server. It sees the
whole program, so it can find callers anywhere in the repo — but it rewrites your
worktree, which is exactly what people do not want to do to glance at a PR.

**Tier A** takes only the files the PR touches, the set GitHub hands you from the API
without a checkout, and recovers the call graph from syntax alone. No `Program`, no
type checker, no `node_modules`.

This document records what Tier A can and cannot do, measured rather than asserted.

## How it works

`src/engine/syntactic-index.js` parses each file with `createSourceFile` and resolves
calls two ways:

- **bare calls** (`compute(x)`) by import specifier plus name;
- **member calls** (`this.store.findLatest()`) by the *declared* type of the receiver.

The second one is what makes this viable in a dependency-injected codebase. Constructor
parameters carry explicit type annotations, and an annotation is syntax — you do not
need inference to read it.

On top of that it tracks the pieces that would otherwise sever the graph:

| Construct | Why it matters |
|---|---|
| `implements` | a member typed as the port must reach the adapter |
| `extends` (transitive) | a call through a subclass must reach the override |
| barrel re-exports | `import { X } from './dir'` where `index.ts` declares nothing |
| `tsconfig` `paths` | `@lib/thing` is a directory alias, not a package |
| `@CommandHandler(X)` | `bus.execute(new X())` resolves to the bus, never the handler |

## Measured results

Oracle: the TypeScript call hierarchy — what Tier B uses today.
Scope: edges whose caller is a file Tier A actually holds. Tier A cannot claim an edge
to a file it was never given, and reporting recall against unreachable edges would
measure the file budget rather than the resolver.

### Tuning set — two DDD/NestJS services, 137-file PR

| File set | Files indexed | Precision | Recall | True edges |
|---|---|---|---|---|
| PR files only | 137 | 100.0% | 78.7% | 140 |
| PR files + 1 import hop | 483 | 100.0% | 82.3% | 177 |

The import hop costs ~350 extra API requests and buys 26% more edges. Recall moves less
than the edge count because widening the file set also widens what the oracle can see.

### Held-out set — three services never used for tuning

A BFF, a Next.js back-office app and an admin service, so the split is by *idiom*, not
just by diff. Different code shapes are what expose over-fitting; more PRs against the
same architecture would not.

| Stage | Precision | Recall |
|---|---|---|
| before the chained-call fix | 95.8% | 90.2% |
| after | **100.0%** | **90.2%** |

The held-out run earned its keep immediately. An unclassifiable receiver was being
recorded as `null` — the same marker as *no receiver at all* — so `xs.map(..).filter(..)`
was treated as a bare call and matched a top-level function named `filter`. Service code
routes through `this.x.y()` and almost never hits this; React code hits it constantly.

Recall reads higher on the held-out set, but the two numbers are **not** comparable:
those codebases have shallower DI indirection and fewer severed CQRS edges. Only the
precision movement says anything about the resolver, because that is a property of the
code under test rather than of the corpus.

## The oracle is wrong about inherited members

Recall looked worse than it was, and the reason turned out to matter more than the
number.

TypeScript's call hierarchy, asked for callers of an **override**, also returns call
sites that dispatch on *sibling* subclasses which do not declare the method at all.
`spike/probe-override.js` measures one such symbol directly:

```
target: SomeRepository.save   (extends BaseRepository, which also declares save())

oracle reports 31 incoming calls
   2  call the override through SomeRepository or its port   (correct)
  25  call save() on a SIBLING class that does not declare it (over-report)
   4  receiver type not determinable syntactically
```

Those 25 calls reach `BaseRepository.save` at runtime. They are not callers of the
override. The syntax-only resolver refuses them, and was being *penalised* for it.

Two consequences:

1. Tier A's recall figures are a floor. Some "misses" are the resolver being right.
2. **Tier B had the same over-report**, because it asks the same API. This is now
   fixed — see below.

`spike/tier-a.js` reports against both the raw oracle and an oracle corrected for this,
so the correction can never quietly flatter the result.

### The fix

`src/engine/inheritance.js` filters the call hierarchy's output in both resolvers. It
is syntax-only, so it costs a parse of each caller file, and it is deliberately
conservative — an edge is dropped only when **all** of these hold:

1. some ancestor of the target's class also declares the method, so there is something
   to confuse it with;
2. every reported call site in that caller dispatches on a type we can actually read;
3. none of those types is the target's class, an ancestor of it, or a descendant.

Anything undeterminable keeps the edge. Hiding a real caller is worse than showing a
spurious one, so every uncertain case resolves in favour of keeping it.

Measured on the same symbol: **31 reported callers → 4**. The 27 dropped all dispatch
on unrelated repositories; of the 4 kept, one is the genuine caller and three have
receivers the filter could not type, so they are kept rather than guessed at.

Two things this needed that a naive version would miss, and which made it silently
no-op at first:

- **non-relative imports.** `import { BaseRepository } from 'src/core/common'`
  is resolved by `baseUrl`, not as a package. Without that the heritage chain stopped
  at the first `extends` and precondition 1 was never true.
- **barrel re-exports.** That specifier points at an `index.ts` which declares nothing.

Turn it off with `impactTree.filterInheritedOverReports: false` to see the raw
call-hierarchy result. The run log reports how many edges were dropped.

## What Tier A cannot do

- **Callers outside the PR.** By construction. If a changed function is called from a
  file the PR does not touch, Tier A cannot see it, and the UI must say so rather than
  present a truncated tree as complete.
- **Untyped receivers.** `const x = getThing(); x.foo()` with no annotation needs
  inference. Unresolved is reported as unknown, never guessed.
- **Dynamic dispatch** — string-keyed lookups, factories, decorators that rewire
  at runtime.

## Reproducing

`spike/` is gitignored: the harness reads a private codebase and its output embeds real
paths and symbol names.

```
IMPACT_TREE_TARGET_REPO=/path/to/repo node spike/tier-a.js <base> [components]
IMPACT_TREE_TARGET_REPO=/path/to/repo node spike/tier-a.js <base> --hop1
IMPACT_TREE_ONLY=svc-a,svc-b IMPACT_TREE_TARGET_REPO=/path/to/repo node spike/tier-a.js <base>
```

`IMPACT_TREE_ONLY` pins the component set so a validation run can use services the
resolver was never tuned against, instead of whichever happen to be largest in the diff.

The behaviours behind these numbers are pinned by `test/syntactic-index.test.js`, which
runs on synthetic in-memory sources in milliseconds and needs no target repo.
