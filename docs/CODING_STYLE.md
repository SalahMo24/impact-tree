# Impact Tree coding style

## Purpose and priorities

Impact Tree helps a reviewer understand the consequences of a code change. Its
most important obligation is to describe what the analysis establishes and where
its evidence ends. An empty result must not conceal a failed or incomplete search.

Use these priorities when making implementation decisions:

1. **Trustworthy findings:** preserve evidence, distinguish uncertainty, and avoid
   presenting unsupported conclusions as facts.
2. **A responsive editor:** bound work and resource use; let users stop or replace
   expensive work.
3. **Maintainable implementation:** make contracts, ownership, and control flow
   understandable enough to review and test.

This guide takes inspiration from
[TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md)
and Gerard Holzmann's
[Power of Ten](https://spinroot.com/gerard/pdf/P10.pdf).
Their emphasis on explicit contracts, bounded work, and mechanically checked rules
is useful here. Their restrictions on allocation and pointers target different
execution environments. The requirements below are this project's adaptation;
they do not imply safety-critical certification or complete static analysis.

## Scope, terminology, and adoption

This guide applies to production JavaScript, tests, and development scripts.
Examples show intended contracts; they are not claims that the current code already
implements those contracts or that their field names are existing public APIs.

- **MUST / MUST NOT** describes a requirement.
- **SHOULD / SHOULD NOT** describes the default; a departure needs a concrete reason.
- **MAY** describes an allowed choice.
- A **boundary** receives data from settings, Git, a network response, disk,
  persisted state, an editor provider, or another independently implemented adapter.
- An **invariant** is a property our implementation promises after validation.
- A **scope** identifies the sources and kinds of relationships actually searched.
- A **budget** is an enforced maximum on work, resources, or elapsed time.

This is a target standard, not a declaration that the repository is compliant.
New code MUST follow it. Changes to existing code MUST address violations in the
behavior being changed, or document an explicit exception. An unrelated violation
does not require a whole-file rewrite. Existing result formats require coordinated
migration across producers, consumers, and tests; do not rename states in one layer
and leave the other layers interpreting the old contract.

An exception MUST state the rule, affected scope, reason, residual risk, and
verification or compensating control. Temporary exceptions MUST also identify the
condition for removal and a tracked follow-up. Keep the explanation beside the
code when it affects future edits. A vague comment such as "needed for performance"
is insufficient. A PR explanation alone is insufficient for a lasting exception.

## 1. Preserve uncertainty in every analysis result

**Intent:** users must be able to distinguish lack of evidence from evidence of
absence within a defined search scope.

An operation that discovers callers, tests, or findings MUST communicate both its
evidence and its coverage. A bare array is acceptable inside a helper only when its
caller independently retains coverage and failure information.

Use these meanings consistently, regardless of the existing field names:

| Concept | Meaning |
| --- | --- |
| Found | At least one relationship was discovered; this alone says nothing about completeness. |
| Not found within scope | The supported search completed for its declared scope and found no relationship. |
| Incomplete | Failure, unavailable input, unsupported relevant behavior, or a work budget prevented the intended search from completing. Known findings can still be retained. |
| Not computed | The operation was deliberately not performed. |
| Cancelled | The operation was stopped; it must not be published as a completed result. |

Scope MUST describe material limitations: for example, PR source files only,
selected workspace projects, supported static call forms, test-file inclusion,
and a requested traversal depth. Completing a syntax-only PR search does not prove
that the repository has no callers. Completing a static search does not rule out
dynamic dispatch or cross-service relationships the analyzer cannot model.

A result can contain valid callers and still be incomplete. Do not force evidence
and completeness into mutually exclusive states that discard this distinction.

```js
// Illustrative result contract, not the current resolver API.
return {
  callers,
  coverage: {
    status: 'incomplete',
    scope: { source: 'pr-files', headSha, includeTests: false },
    reasons: ['request-failed'],
  },
};
```

MUST NOT convert a failed query into a successful empty result:

```js
// Incorrect if downstream code interprets [] as a completed search.
try {
  return await resolver.incoming(file, offset);
} catch {
  return [];
}
```

Instead, propagate the error or return explicit incomplete coverage. A warning in
a log is not sufficient when the UI still presents a definitive negative result.
Aggregation MUST preserve relevant failures and truncation from child operations.

For test reachability, a found path means **a test is statically reachable**. It
does not prove that a test executes the changed behavior, asserts it correctly, or
passes. A failed or budget-limited search with no found test MUST NOT become a
definitive "uncovered" conclusion. UI labels and tooltips MUST honor this meaning.

**Verification:** test successful empty searches, partial success followed by
failure, missing providers, unsupported resolution, budget exhaustion, and deferred
work. Check the user-visible interpretation as well as the engine result.

## 2. Bound work at the point where it is performed

**Intent:** a large repository or slow dependency must not cause uncontrolled work
or make the extension host unresponsive.

Every operation whose cost grows with external input MUST have an explicit budget
or inherit a documented bound from its validated input. A loop over an already
bounded array does not need a second arbitrary iteration counter.

Relevant budgets include:

| Operation | Bounds to consider |
| --- | --- |
| Graph traversal | Visited nodes, examined edges, queued work, depth, elapsed time. |
| Remote loading | Concurrent requests, pages, files, bytes per file, total bytes, deadlines, retry count. |
| Parsing and indexing | Input size, files/projects admitted, elapsed time, retained source/AST memory. |
| UI construction | Materialized rows, expansion work, batches of synchronous work. |
| Caching | Entries or estimated retained bytes, lifetime, eviction/disposal. |

Depth alone does not bound breadth. A visited set prevents repeated visits but does
not cap the size of an acyclic graph. Limiting displayed children does not bound
the cost of loading all callers first. Concurrency limits bound simultaneous work,
not total work.

Check a budget **before** scheduling, inserting, or reading work that would exceed
it. Count admitted work consistently. Specify whether the root consumes a graph
budget and whether repeated edges consume an edge budget. Check deadlines and
cancellation during long traversals, not only after they finish.

Each budget MUST document its unit, default, valid range, owner, enforcement point,
and exhaustion behavior. Choose defaults using representative workloads and record
the rationale; this guide does not invent universal limits for all analyses.
Existing defaults are starting points to evaluate, not proof of sufficient bounds.

Budget exhaustion MUST either fail the operation clearly or return explicitly
incomplete results. Reaching a display limit may instead mean presentation is
truncated while analysis is complete; preserve that distinction. When exactly at a
cap, do not claim more results exist unless known. If completion is uncertain, say
so or use a bounded lookahead.

Network reads MUST have explicit deadlines. Enforce response-size limits while
reading; checking after loading an arbitrary body does not bound peak allocation.
Retries MUST have a maximum attempt count, a total deadline, and an explicit set of
retryable failures. Do not retry authentication failures indiscriminately.

Heavy synchronous parsing or traversal SHOULD run in a worker or be split into
bounded batches when it would block the editor. Declaring a function `async` does
not make synchronous work nonblocking. A timer cannot interrupt synchronous work
already blocking the event loop.

**Verification:** exercise the limit minus one, exactly the limit, and the limit
plus one; include wide graphs, deep chains, cycles, slow requests, and oversized
inputs. Assert work counts or admission behavior, not only the final array length.

## 3. Validate external data before trusting it

**Intent:** malformed input must become an actionable boundary error rather than a
misleading downstream result.

Validate the fields actually used, including their relationships. For example:

- Concurrency MUST be a positive safe integer within its supported maximum.
- Depth and counts MUST have documented integer ranges and zero semantics.
- Source positions MUST be valid for the source revision they refer to.
- Required revision identifiers MUST be present before fetching revision data.
- Persisted state MUST have a recognized format/version before being reused.
- Network responses MUST match the expected kind and required field types.

Do not rely on truthiness, coercion, or defaults to repair supplied invalid values.
Defaults apply to omitted optional values. If clamping is intentional, document it
as part of the setting's contract and expose the effective value where relevant.

```js
function validateConcurrency(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`Concurrency must be an integer from 1 to ${maximum}`);
  }
  return value;
}
```

Here `maximum` is an internal validated constant or policy value. Zero MUST NOT
accidentally create a worker pool that does no work and reports success.

Validation errors are expected operating errors. Present useful context without
logging credentials or source contents unnecessarily. Validate once at a clear
boundary and pass a documented validated value internally; do not duplicate a full
schema check in every leaf function.

**Verification:** cover missing values, zero, negative values, fractions, `NaN`,
infinity, strings where numbers are required, and malformed response objects as
applicable to the boundary.

## 4. Assert the assumptions that make an algorithm correct

**Intent:** detect our own programming errors close to their cause.

Use assertions for internal invariants, such as a graph edge referencing a known
node, a result belonging to the expected revision, or a normalized range satisfying
`0 <= start <= end <= text.length`.

Assertions MUST be side-effect free. Use a throwing assertion mechanism such as
Node's `assert/strict`; `console.assert` is not an enforcing contract. Include enough
context to diagnose the violated property. Production-critical correctness checks
MUST remain active in production.

There is no assertion quota. Two artificial assertions in a trivial function add
less value than one precise invariant in a graph algorithm. Assert properties that
are important, nontrivial, and owned by the implementation.

An invariant failure MUST abort the affected computation. The extension boundary
may catch it to report an internal error and discard the affected result. It MUST
NOT reinterpret it as ordinary incomplete success or continue using corrupted
state. Do not deliberately terminate the shared editor extension host. A CLI may
report the error and exit unsuccessfully.

**Verification:** test important invariant failures and ensure broad recovery
handlers do not conceal them as empty or successful results.

## 5. Give asynchronous work explicit ownership

**Intent:** errors, cancellation, and stale completions must not escape the operation
that started the work.

Every promise MUST be awaited, returned to an owner, or launched as deliberate
background work with a rejection handler and lifecycle owner. `void promise` alone
does not handle rejection. Background warm-up needs the same ownership discipline
as user-triggered analysis.

Each analysis MUST retain its input identity: repository, mode, relevant revisions,
and, for mutable working files, a snapshot or version strategy. A check before an
`await` does not establish that shared state is still valid afterward.

Before publishing results, progress, errors, decorations, or cleanup affecting
shared state, verify that the operation still owns that state. An obsolete run's
`finally` block must not mark a newer run idle or clear its resources. Serializing
all such operations is also acceptable if the ownership guarantee is explicit.

Cancellation MUST stop scheduling new work and propagate to dependencies that can
cancel. If a provider cannot cancel, stop waiting as appropriate and suppress late
publication; document that underlying work may continue. `Promise.race` with a
timer bounds waiting, not the lifetime of the losing operation.

Use `try/finally` for resources owned by an operation. Remember that `Promise.all`
rejecting does not stop sibling tasks: arrange cancellation and settling, or isolate
their resources, before disposing state they may still access.

**Verification:** use controlled promises to complete an older run after a newer
one. Test cancellation during fetch and resolution, background rejection, and
cleanup after one worker fails. Avoid timing-dependent sleeps when explicit
scheduling can reproduce the scenario.

## 6. Make state ownership and lifetime explicit

**Intent:** avoid results contaminated by another repository, revision, or operation,
and avoid retaining resources indefinitely.

Every mutable cache, resolver, subscription, timer, and virtual document collection
MUST have a named owner and a defined cleanup path. Prefer analysis-local state when
reuse is unnecessary. Long-lived state needs a documented invalidation policy.

Cache identity MUST include all inputs that can change its answer, either in the
key or through the cache owner's immutable context. Depending on the cache, these
include repository, revision/document version, resolver configuration, and test
inclusion. A file path alone is not a revision identity.

Do not let consumers mutate shared cached values accidentally. Return copies, use
immutable values, or explicitly document ownership transfer. `const` prevents
rebinding; it does not make an object immutable.

Keep variables in the smallest useful scope. Avoid keeping several independently
mutable copies of a derived value. If a performance cache duplicates information,
document the authoritative source and invalidation rule.

Persisted review identity MUST reflect reviewed content and relevant context.
Offsets locate symbols but are insufficient persisted identities because unrelated
edits move them. Preserve completed preview documents only with a deliberate
lifetime policy that also bounds retention.

**Verification:** test revision changes, multiple repositories, repeated analyses,
cache invalidation, and disposal. Check that older preview identities cannot return
newer content accidentally.

## 7. Separate computation from external effects

**Intent:** make core analysis reproducible without an editor session or network.

Graph selection, scoring, signature comparison, and range classification SHOULD be
pure computations over supplied data. Orchestration owns I/O, progress reporting,
cancellation, and publishing. Adapters own Git, HTTP, filesystem, language-service,
and editor interactions.

Pass dependencies explicitly where behavior must vary or be tested. Do not hide
network or disk reads in a function that appears to classify an already loaded
value. Lazy loading is allowed when the interface documents that it performs I/O.

Share domain rules between CLI, local analysis, and PR preview when their semantics
are the same. Keep differences in coverage and capabilities explicit. Do not force
two implementations through a common abstraction that erases those differences.

Prefer a small helper with a concrete contract over a framework built for imagined
future uses. Existing duplication is a reason to evaluate a shared abstraction,
not proof that every similar-looking operation has identical semantics.

**Verification:** test computations with small supplied inputs; test adapters and
their boundary behavior separately; retain integration tests for their composition.

## 8. Keep control flow understandable and traversal safe

**Intent:** a reader must be able to explain why work terminates and how each case is
handled.

Use ordinary functions, early returns, explicit loops, and straightforward branches.
Callbacks and promises are normal JavaScript tools and are allowed. Production
analysis MUST NOT depend on `eval`, dynamically constructed functions, or hidden
prototype mutation. Dynamic module loading for an explicitly selected compiler is
allowed when its capabilities are validated.

Potentially deep input-controlled graph traversal SHOULD use an explicit worklist.
Recursion is allowed only with a documented bound on depth and total work and a
reason it is clearer. Asynchronous recursion can still generate excessive work;
avoiding synchronous stack growth does not establish a resource bound. Traversals
delegated to a parser/library need input limits and an explicit failure boundary.

Choose visited-set semantics deliberately:

- A global visited set counts or processes distinct nodes.
- A path-local visited set prevents cycles while preserving a shared node under
  multiple tree branches.

These are not interchangeable. Preserve self-recursive roots, mutually recursive
components, and diamonds according to the operation's contract.

Functions SHOULD represent one explainable responsibility. More than roughly 70
nonblank, noncomment lines is a review trigger, not an automatic failure. Split at
domain boundaries, not arbitrary line counts. A coherent algorithm may remain
longer with a rationale; do not compress statements to evade review.

**Verification:** include deep chains, self-cycles, multi-node cycles, diamonds, and
disconnected components. Review traversal complexity and termination alongside tests.

## 9. Make types, units, and names express the domain

**Intent:** values that look alike must not be silently treated as interchangeable.

Keep the current CommonJS JavaScript conventions unless a migration is explicitly
scoped: `'use strict'`, `require`, `module.exports`, two-space indentation, and
camelCase for functions and variables. Use `const` by default and `let` for
reassignment. Do not introduce a repository-wide naming rewrite to imitate Zig.

Add JSDoc contracts for public module boundaries and complex result objects. Adopt
JavaScript type checking incrementally. Type checking complements runtime boundary
validation; a type annotation does not validate network JSON.

Names and contracts MUST make these distinctions explicit:

- Byte lengths versus JavaScript UTF-16 code-unit offsets.
- Zero-based editor lines versus one-based diff/display lines.
- Inclusive versus exclusive range ends.
- Counts versus indexes; durations with units such as `timeoutMs`.
- Repository-relative paths versus absolute filesystem paths and document URIs.
- Mutable branch names versus pinned revisions.
- Absent source content versus an empty source file.

For new internal text-range APIs, prefer zero-based UTF-16 offsets with an exclusive
end. Existing formats such as Git hunk ranges retain their own conventions; convert
at named boundaries. Do not silently change a range convention in place.

Use options objects when positional arguments are easy to swap or booleans conceal
their meaning. Prefer explicit result variants over overloaded `null`, `false`, and
empty arrays. Document all variants and make callers handle them exhaustively where
the type checker supports it.

Comments SHOULD explain why a decision is necessary, which invariant it preserves,
or which limitation remains. Keep comments consistent with current behavior.
Avoid abbreviations except conventional short indexes in small algorithmic scopes.

**Verification:** test Unicode, empty content, boundary offsets, rename paths, and
platform-specific path handling where conversions occur. Run type checking for the
modules enrolled in it.

## 10. Make the standard enforceable and verify observable behavior

**Intent:** correctness must not depend on every reviewer remembering every rule.

The target verification pipeline consists of formatting checks, linting, JavaScript
type checking, focused unit/regression tests, and applicable integration tests.
Adding this document does not install or configure those tools. Until configured,
describe checks actually performed; do not claim a lint or type-check pass that did
not run.

Adopt static checks incrementally with zero unexplained diagnostics in enrolled
modules. Suitable checks include undefined identifiers, accidental globals, missing
promise handling, unreachable code, and unsafe result access. Promise rules may
require type-aware tooling. Lint does not prove graph completeness, budget safety,
or correctness of a coverage label; those require contracts, review, and tests.

Tests MUST assert behavior rather than restate implementation steps. For a bug fix,
include a regression that distinguishes the incorrect behavior from the intended
behavior. Include relevant negative cases: a resolver must not invent an edge just
because two symbols share a name.

Keep small deterministic fixtures for correctness. Use representative repositories
for integration and performance, recording the revision, comparison range, relevant
configuration, and dependency assumptions. A skipped test is not a pass. A passing
caller-location check verifies reported locations; it does not establish that all
callers were discovered. Track false positives and missed expected callers separately.

Use injected clocks, providers, or controlled promises for reproducible failures
and races. Generated graph tests SHOULD use reproducible seeds and retain a minimal
regression when they find a bug. Snapshot changes need a reviewed explanation of
the semantic difference; do not regenerate expectations merely to make tests pass.

Performance claims MUST distinguish cold and warm runs and record workload and
environment. Check wall time, event-loop responsiveness, and retained memory as
appropriate. A larger heap setting is not a substitute for investigating retention.

Development dependencies that provide meaningful verification are allowed. Runtime
dependencies need a concrete benefit, maintenance/security consideration, and an
acceptable effect on extension startup and packaging. Keep lockfile changes
intentional; there is no blanket zero-dependency requirement.

**Verification:** run the checks relevant to a change and the required suite before
shipping. Report failures, skipped coverage, external prerequisites, and any live
editor behavior that was not exercised.

## Review checklist

For each applicable item, the change should provide evidence in code, tests, or its
description. Mark genuinely irrelevant items as not applicable rather than adding
ceremonial code.

- Can a failure, unsupported case, or cap be mistaken for no impact?
- Are inputs validated, and are scope, units, and range conventions explicit?
- Is expanding work bounded where it is admitted, including queue and memory use?
- Can cancellation or an obsolete completion mutate the current review?
- Who owns each mutable resource, and how is it invalidated or disposed?
- Are internal invariant failures distinguishable from expected operating errors?
- Do traversals preserve the intended cycle and shared-node semantics?
- Do tests cover the meaningful failure and boundary cases?
- Were relevant checks run, with skips and limitations reported accurately?
- Are exceptions specific, justified, and visible to the next maintainer?

## Initial implementation sequence

Apply this guide through reviewable changes rather than a broad cosmetic rewrite:

1. Preserve incomplete coverage through caller and test-reachability results and
   their UI consumers. Add regression tests for failures and budget exhaustion.
   - Exists: the test-reach walk is `walkTestReach` in `src/engine/test-reach.js`, with the
     resolver injected. `testState` is `'covered'`, `'uncovered'` (the walk finished within
     its depth and budget), `'unknown'` (a query failed or was incomplete, or the
     visited-node budget stopped it; `testReachIncompleteReason` says why) or
     `'not-computed'`. Depth is a declared scope, not a budget: `'uncovered'` means no
     test within `reachDepth` caller levels, and the tree and CLI say so. Tests are
     searched at every level. In the tree only an `'uncovered'` change row reads
     "no test"; an `'unknown'` one says "Test reach unknown" with its reason in its tests
     row and tooltip, and the CLI reports both.
2. Validate settings and consolidate genuinely equivalent concurrency helpers.
   Establish documented budgets and exhaustion behavior.
   - Exists: `src/engine/settings.js` validates `impactTree.concurrency` (1..32),
     `impactTree.reachDepth` (1..6) and `impactTree.tierA.maxFiles` (1..3000) with one
     rule: omitted uses the default, an unusable value uses it with one warning, a value
     above the maximum is clamped with one warning. The ranges are in `package.json`.
   - Exists: the budgets are documented where they are defined, with unit, default and
     what happens when hit: test reach (`test-reach.js`), `blastRadius` and `buildTree`
     (`forest.js`), and the module-caller index (`module-callers.js`).
   - Planned: budgets for the rest of the forest and for UI row construction.
3. Add request deadlines, cancellation, analysis ownership, and predictable cleanup.
   - Exists: analysis ownership in `src/session.js`. One private lifecycle (`starting`,
     `preparing`, `analysing`, `checkingOut`, `ready`, `disposed`); every entry point
     goes through session operations (`beginAnalysisRun`, `completeAnalysisRun`,
     `failAnalysisRun`, `releaseAnalysisRunResources`, `beginCheckout`/`endCheckout`,
     `isCurrentAnalysis`, `dispose`). Admission is cancel and replace; a request during a
     checkout is refused; a checkout waits for the analysis it cancels to settle.
     Replaced, cancelled and post-disposal runs publish nothing; lazy tree expansions
     and decorations check the analysis id they started under.
   - Exists: cancellation reaching the engine. `analyze()` and `analyzeRemote()` take an
     `AbortSignal`, `mapLimit` stops scheduling once it is aborted, and both reject with
     `AnalysisCancelledError` (`src/engine/cancellation.js`). The editor's language
     server cannot be cancelled: its in-flight query finishes and the answer is dropped.
   - Exists: bounded GitHub requests. Every call goes through `fetchBounded`
     (`src/github-request.js`), which applies a 30 s deadline, the caller's
     `AbortSignal` (so cancelling stops an in-flight request, and a late body is never
     read), and size limits enforced while the body streams (2 MiB per file, 10 MiB per
     JSON response). The open-PR list is capped at 10 pages and reports truncation only
     when a further page exists. Responses are validated for the fields used. Each
     limit's unit, owner, enforcement point and exhaustion behaviour is documented at
     `DEFAULT_LIMITS`. Not done: retries (there are none) and the language-server limit
     above.
4. Make cache identity and retention policies explicit; address expensive editor
   work using measurements.
   - Exists: every cache has a comment at its definition stating owner, what its key
     covers, invalidation and disposal: the TypeScript, editor and syntactic resolvers and
     their service pool, the syntactic index, `textpos` line starts and virtual text, the
     review-identity caches, the inheritance filter, and the session-owned
     `resolver`/`readyPromise` (`src/session.js`).
   - Exists: `prDocuments` (`src/pr-documents.js`) holds only the current preview's text;
     publishing a new preview releases the previous one. An `impacttree-pr:` address
     carries the PR number, head commit and merge-base commit, the base-side path of a
     renamed file (`from`), and `absent=1` for a side that does not exist. `prQuery` is the
     only place that builds it. The tree rows' own identity URIs in `tree-provider.js` omit
     the last two because no command opens them.
   - Exists: a tab on a revision that is not held is fetched from GitHub through
     `gh.fileAtRef` at the commit and path in its address, under the request limits in
     `src/github-request.js`, and nothing it fetches is kept. A failure shows a message
     naming the cause (signed out, no longer on GitHub, timeout, too large, other) and what
     to do; a side marked absent is an empty document without a request.
   - Exists: file-row review tokens are not cached. Measured on t3code (Apple M3 Pro,
     Node 22), a repaint re-reading and hashing the head of 300 changed files (3 MB) takes
     about 10 ms; 1000 files (11 MB) about 120 ms; 3000 files (33 MB) about 370 ms. That
     is below noticeable at the sizes a review usually has, and a cache would stop an edit
     from unticking a file until the next analysis.
   - Planned: a stat-keyed token cache, if reviews of more than about a thousand changed
     files prove common; measure again before adding it.
5. Enroll modules in linting and JSDoc type checking, then enforce those checks in
   CI. Broaden coverage as modules are brought into compliance.
   - Exists: `npm run lint` (ESLint flat config), `npm run typecheck` (`tsc` over
     `jsconfig.json`, strict, `checkJs` off), and `.github/workflows/ci.yml`, which runs
     both plus `npm test` against a pinned `pingdotgg/t3code` commit.
   - A file is enrolled in both checks by putting `// @ts-check` on its first line;
     there is no other list. Enrolled today: `src/engine/concurrency.js`,
     `src/engine/call-sites.js`, `src/engine/caller-contract.js`,
     `src/engine/cancellation.js`, `src/engine/settings.js`, `src/engine/test-reach.js`,
     `src/github-request.js`, `src/github.js`, and the tree's provider, pure row models,
     grouping and renderer (`src/tree-provider.js`, `src/review-tree-model.js`,
     `src/tree-row-models.js`, `src/tree-grouping.js`, `src/tree-item-renderer.js`).
   - Planned: type-aware lint rules such as `no-floating-promises` (whether to add them
     before the review loop is an open decision), and enrolling the remaining modules.

This sequence is a migration plan, not permission for newly written code to defer
the applicable requirements. Update it as implementation lands so readers can tell
which protections exist and which remain planned.
