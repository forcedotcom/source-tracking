# V8 Competing-PR Improvement Ledger

## Purpose

Maintain independently reviewable v8 responsiveness improvements as an
alternative to the v9 Effect Git rewrite. Retain accepted improvements in this
worktree with focused tests and same-thread evidence. Do not bundle unrelated
experiments into one correctness claim.

## Branch

```text
sm/W-22711959-v8-shared-loop
base: origin/main v8.1.12 (f795703)
```

## Accepted Improvements

| ID    | Improvement                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                 | Decision record                               |
| ----- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| V8-01 | Skip `correctSourceMemberNames()` local-source crawl when no remote change is `NavigationMenu` or `Audience`. | On a 5,100-file decomposed-object fixture, the old path had a 13.94 ms heartbeat gap; the guarded path had a 1.27 ms gap. Preserves correction behavior for allowlisted types.                                                                                                                                                                           | `0001-v8-shared-event-loop-responsiveness.md` |
| V8-02 | Yield after each 100 resolver operations while building local deploy component sets.                          | On a mixed 5,450-file fixture (decomposed objects, LWC/Aura bundles, Apex classes), maximum heartbeat gap fell from 481 ms to 16 ms while wall time remained about 0.5 s. One resolver and one ComponentSet remain scoped to each grouping.                                                                                                              | This record                                   |
| V8-03 | Yield after each 100 local name/type resolver operations and component enrichments.                           | On a mixed 5,350-change fixture (decomposed objects and LWC/Aura bundles), maximum heartbeat gap fell from 327 ms to 26 ms while wall time remained below 0.4 s. A 201-file production-enrichment regression confirms a same-thread timer runs before completion. One resolver and the ordered element/component maps remain scoped to each invocation.  | This record                                   |
| V8-04 | Reuse a matched remote component's file list for both debug output and `ChangeResult.filenames`.              | On a 2,000-LWC-bundle remote-path fixture, wall time fell from 537 ms to 453 ms. This removes one eager `walkContent()` per matched component but does not make the underlying `ComponentSet.fromSource()` traversal interruptible.                                                                                                                      | This record                                   |
| V8-05 | Build SourceMember timeout-warning groups with mutable per-type buckets.                                      | Replaces repeated copying of each growing same-type names array with one append per member. The regression proves first-seen type order, within-type name order, duplicate LWC bundle names, exact punctuation, and platform `EOL` separators are unchanged.                                                                                             | This record                                   |
| V8-06 | Bound local move-detection candidate operations and yield between complete work units.                        | Limits added/deleted read-or-blob/hash operations to 32 at a time, preserves global matching state and phase ordering, and yields after 100 complete metadata resolutions. On the 400-candidate-path workload, longest heartbeat gaps fell from the 18.1–24.5 ms baseline range to 7.6–12.1 ms across six post-change samples, with clean normalization. | This record                                   |

## Extension-Host Attribution Note

The EDA/EDO cold-start experiment separates intrinsic STL status work from
extension-host startup contention. EDA has 6,408 status rows. With the broader
extension set, the first `STL.GetStatus` span was consistently 2.4–2.7 s while
`STL.ReReadLocalTrackingCache` and `STL.ReReadRemoteTracking` ran concurrently
and each completed in about 0.4–0.65 s. A standalone EDA profile measured
`getStatus()` at 0.66–0.73 s.

A controlled extension host with only Services, Core, and Metadata reduced the
first EDA `STL.GetStatus` span from 2,489 ms to 750 ms and the complete status
operation from 3,124 ms to 1,322 ms. Local and remote rereads remained about
0.55 s. This is strong evidence that the earlier multi-second span was inflated
by competing extension/workspace startup activity; it is not evidence that STL
alone blocks the event loop for the whole span duration. This finding does not
rule out focused improvements to isomorphic-git's status traversal.

## Isomorphic-Git Status Traversal Decision

STL already calls `statusMatrix()` with package-directory `filepaths`. In
isomorphic-git, the `filepaths` predicate runs in the `map` callback before
recursing into a directory's children. This prunes non-package directory trees
while preserving all paths under each package root, including untracked files,
tracked deletions, and the complete added/deleted candidate sets used by move
detection. No narrower STL-owned `filepaths` input is correct for a full local
status refresh.

The default `_walk()` iterator recursively starts all sibling paths with
`Promise.all`. A local isomorphic-git experiment that exposed its existing
`WalkerIterate` callback through `statusMatrix()` allowed a batch-of-32 iterator
with `setImmediate` yields. On EDA, its status-matrix digest matched the default
digest (`cdedc38dba76093639551f5b4f31481edb64cd74e0163510c5685634e1c3a997`).
One matched direct run reduced wall time from 144.5 ms to 82.3 ms and the
largest heartbeat gap from 38.5 ms to 20.5 ms. The broader extension-host probe
did not show a repeatable benefit: both the batched and control local rereads
continued to run timer callbacks, and host-startup contention dominated their
gap measurements.

Therefore, do not ship an STL environment flag or a patched isomorphic-git
dependency. The focused API proposal is upstream-only: add the optional existing
`WalkerIterate` contract to `statusMatrix()` and forward it to `_walk()`, with
the default behavior unchanged. The proposal is independently useful because
public `walk()` already documents the same scheduling hook. If maintainers
accept it, revisit an STL integration only with repeated consumer-level
responsiveness evidence.

## V8-03 Alternatives Declined

V8-03 yields only at STL-owned unit boundaries: after a complete filename
resolution or a complete component enrichment. It cannot interrupt synchronous
work inside SDR's resolver or a component content walk. The following options
are declined for this improvement, not permanently rejected.

| Alternative                                       | Decision | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move resolution to a worker                       | Declined | A Node `worker_threads` implementation would not satisfy browser-hosted IDE consumers. A cross-platform executor requires separate Node-worker and Web-Worker implementations, bundled worker entry points, a serializable request/result/error contract, and worker-local reconstruction of registry, ignore, filesystem/tree, logging, cancellation, and stale-result behavior. This is an execution-model project, not a local scheduling change. |
| Make SDR resolution/content traversal incremental | Declined | STL cannot yield while `MetadataResolver.getComponentsFromPath()` or `SourceComponent.walkContent()` runs synchronously. Making those operations chunkable requires SDR APIs such as async iterators or callbacks and changes a lower-layer contract outside this v8 branch's minimal scope.                                                                                                                                                         |
| Replace resolver traversal in STL                 | Declined | Reimplementing SDR resolution in STL risks metadata-resolution, ignore, bundle, and virtual-delete compatibility. It duplicates a dependency rather than addressing the measured local scheduling boundary.                                                                                                                                                                                                                                          |
| Promise/microtask yielding                        | Declined | `await Promise.resolve()` does not allow timer- and I/O-backed extension-host callbacks to run. `setImmediate` is used so unrelated same-thread work can make progress between STL-owned units.                                                                                                                                                                                                                                                      |

Reconsider these alternatives only if a matched VS Code Services workload shows
material callback delay caused by a single resolver invocation or a single large
bundle walk after V8-02 and V8-03. That evidence would establish that unit-boundary
cooperative scheduling is insufficient and justify a broader architecture decision.

## Deferred SDR Async-Resolution Proposal

V8-04 confirms that `ComponentSet.fromSource()` remains a single synchronous
operation: a 2,000-LWC-bundle remote-path fixture still had no in-operation
heartbeat after the duplicate `walkContent()` was removed. A future SDR proposal
could add async siblings without replacing the synchronous API:

```ts
MetadataResolver.getComponentsFromPathAsync(fsPath, inclusiveFilter, { yieldEvery, yield });
ComponentSet.fromSourceAsync({ fsPaths, registry, tree, include, fsDeletePaths, yieldEvery, yield });
```

The async resolver would process directory entries in bounded batches and invoke
a caller-supplied yield between batches. STL could supply `setImmediate` in a
Node extension host; browser consumers could supply a browser-safe macrotask
yield. Existing `getComponentsFromPath()` and `fromSource()` would remain
synchronous and unchanged.

This is deferred rather than proposed as part of the v8 work for the following
reasons:

- SDR's tree abstraction, resolver, and `SourceComponent.walkContent()` are
  synchronous today. Async path resolution expands a mature public API rather
  than changing an STL-local loop.
- SDR has broad direct and indirect callers. The async path must prove exact
  parity for component ordering, include filtering, force-ignore behavior,
  virtual trees, destructive paths, resolver errors, and telemetry.
- Batching can yield between directory entries but cannot interrupt one
  synchronous adapter resolution, XML/decomposition operation, or one oversized
  `walkContent()` call. An async resolution API alone may not solve every large
  bundle case.
- Two APIs create ongoing maintenance cost and can drift. Maintainers may
  reasonably require shared traversal internals, exhaustive parity tests, and a
  demonstrated cross-consumer need before accepting that cost.
- A caller-supplied scheduler introduces platform and cancellation semantics
  that SDR does not currently own. Its contract must work consistently in Node
  and browser-hosted IDE environments.

Before reopening this option, collect a matched VS Code Services workload that
attributes material callback delay to `ComponentSet.fromSource()` after V8-04.
An SDR spike should then add only async directory traversal and
`ComponentSet.fromSourceAsync()`, with injected deterministic yields and
sync/async output-equality coverage. Treat async `walkContent()` and worker
execution as separate follow-on architecture decisions.

## Forced Status-Refresh Coalescing Decision

**Decision: defer an STL concurrency design; do not add a narrow status-only
single-flight promise.** The inspected VS Code Services path is one consumer,
not an STL concurrency guarantee. Its debouncing and per-resource semaphores
are evidence that callers need to protect shared tracking work; they may be
compensating for mutable behavior in the module they depend upon.

The Services observations are still useful, but bounded:

- File watcher events publish to a PubSub and do not call STL directly.
- The status bar applies three 500 ms debounce stages and consumes its merged
  refresh stream sequentially.
- One `SourceTrackingService` instance has one-permit local and remote
  semaphores, so overlapping same-resource service requests wait rather than
  run together.

They do not cover direct STL callers, other IDE consumers, multiple service
instances, or callers with different local/remote intent. More importantly,
status refreshes mutate shared local and remote tracking state; they are not
interchangeable pure reads. A status-only in-flight promise that returns the
first request's result to a later request is debounce, not correct coalescing:
it could coalesce incompatible requests or hide a newer forced refresh while
leaving the underlying mutation races unchanged.

Correct coalescing would retain each request as demand for an observation at
least as new as its request generation. If request B arrives while A is
running, B may share A's underlying work only when A satisfies B's requested
generation and local/remote scope. Otherwise B must cause one follow-up pass
after A settles; it must not receive A's stale result merely because A was
in-flight.

The investigation identified the following STL concurrency risks and evidence
requirements:

- Direct STL callers have no single-flight or stale-result contract.
- Local-only and remote-only service calls use different permits and can overlap.
- Effect interruption releases a service permit even while its wrapped STL
  Promise can continue running and mutating tracking state.
- Forced local and remote rereads have no full snapshot/exclusion protocol.

Revisit as a dedicated STL concurrency candidate. First add deterministic,
gate-controlled tests that reproduce overlapping forced local scans, remote
revision reads, and concurrent `getStatus` option combinations without relying
on Services. Include A-then-B cases where B arrives during A and must observe a
post-A generation. Then choose a design that explicitly defines
option-compatible sharing, cancellation, lock ordering, operation generations,
queued follow-up refreshes, and local/remote tracking-state consistency. A
matched consumer workload remains useful for prioritization, but is not the
sole correctness criterion.

### Preferred Direction: Project/Org-Scoped Critical-Section Locks

Prefer locks over a transaction framework or a status-only promise cache. The
goal is write isolation among controlled STL operations sharing the same
`(projectPath, orgId)`, not an atomic snapshot of a changing filesystem and
remote org.

Proposed critical sections:

```text
local lock:
  scan shadow-repo status
  → detect and normalize moves
  → commit move changes when needed
  → publish final local status cache

remote lock:
  retrieve SourceMembers
  → merge remote revision/member state
  → persist remote tracking state
  → publish final remote state
```

Operations requiring both coherent refreshed views acquire locks in a fixed
order, `local → remote`, and release them before pure output formatting when
possible. This prevents lock inversion while avoiding a global lock for
unrelated projects or orgs.

The design must support both in-process coordination and overlapping CLI/IDE
processes. Reuse or extend an existing filesystem lock primitive only after
proving its ownership, reentrancy, crash/stale-lock, timeout, and error
semantics fit the complete critical section. Git's index lock protects only
index writes and is insufficient for the semantic refresh lifecycle.

Required proof before implementation:

- Gate-controlled local/local, remote/remote, and combined overlap tests prove
  that critical sections do not interleave.
- Cross-process tests prove that two CLI invocations sharing one project/org
  cannot overlap a protected mutation lifecycle.
- Failure, cancellation, timeout, and process-crash tests prove lock cleanup or
  defined stale-lock recovery.
- Existing move detection, remote revision merge, and status/conflict behavior
  remains correct under lock acquisition and fixed ordering.

### Lock Primitive Decision

Implement an STL-owned lock protocol rather than adopt a lockfile dependency.
Use the portable atomic-create approach already used by the v9 Git layer:

```text
create <sentinel>.lock exclusively
  → success: own lock
  → exists: wait with bounded backoff, then return a recoverable timeout error
run protected operation
  → release in finally on success, failure, and cancellation
```

The implementation must depend only on STL's existing filesystem, path, clock,
and timer abstractions/polyfills. That keeps one lock algorithm usable in the
desktop Node host and ICD/browser bundle without relying on CommonJS behavior,
process-exit hooks, or a third-party module's implicit stale/heartbeat policy.
It also keeps ownership, retry, timeout, cancellation, and error semantics in
STL's public design rather than split between dependencies.

The initial protocol deliberately does **not** auto-delete stale locks. Portable
filesystem APIs provide atomic create but not a compare-and-swap operation that
can prove the holder observed as stale is still the holder being removed. An
automatic `stat → remove → create` sequence can therefore delete a newly
acquired lock. Until a host supplies an ownership-safe lease/recovery primitive,
timeout plus explicit recovery is safer than unsafe stale takeover. The lock
directory includes an owner token so a prior holder cannot remove a replacement
owner's lock during release.

Implementation status: the local lane holds the lock across forced status scan,
move detection, move-normalization commit, and final cache refresh. Internal
helpers avoid reacquiring the non-reentrant lock during
`getStatus → detectMovedFiles → commit → refreshStatus`.

The remote lane locks state mutation and persistence, not polling or org query
waits. Before a normal mutation, it merges disk-only members and non-regressing
`lastRetrievedFromServer` values into the current in-memory state, then writes
under the remote lock. This preserves state persisted by another process while
not discarding updates already staged in the current service. `reset` remains a
deliberate replace-all operation. Polling remains outside the lock because it
awaits lifecycle callbacks; each returned batch acquires the lock only for its
merge-and-persist transaction.

The ICD probe remains useful evidence: the Services browser build aliases its
filesystem calls to `@salesforce/core/fs` with forced memfs. A custom lock can
therefore use exclusive directory or file creation in both targets. However,
the lock scope is the scope of the supplied filesystem. Core creates a memfs
volume per module runtime and Services persists workspace state separately
through IndexedDB, so a memfs lock does not establish sharing across browser
runtimes, tabs, workers, or a desktop CLI. The host adapter must report the
scope it can actually protect; it must not silently claim cross-runtime
exclusion where none exists.

**Accepted limitation/risk:** browser-hosted locks provide exclusion only within
the shared scope of the filesystem adapter. With Core's per-module-runtime
memfs, separate ICD tabs, workers, and isolated browser runtimes can acquire
the same apparent lock independently. This branch accepts that limitation;
Node processes sharing a filesystem are covered, but browser cross-runtime
exclusion is not claimed or tested. Revisit only if the host supplies a shared
lock/storage primitive (for example, a host-owned IndexedDB lease with
ownership-safe release) and a consumer requires cross-runtime coordination.

The lock protocol remains advisory: only cooperating STL processes/hosts can
participate. It does not replace in-process reentrancy ownership, operation
ordering, cache invalidation, or output-generation semantics. Candidate
selection requires Node and ICD/browser integration tests before it protects
any tracking mutation lifecycle.

## Retention Rules

- Keep each accepted improvement, its regression test, and its benchmark or
  heartbeat scenario in this branch.
- Make each improvement independently removable and independently reviewable.
- Preserve consumer-level findings in ADRs, including the VS Code Services
  trigger path.
- Document rejected experiments with their evidence, but revert their production
  code before starting the next candidate.
- Do not compare v8 and v9 until the v8 workload matrix has measured each
  accepted v8 improvement under equivalent consumer-level scenarios.

## Candidate Queue

1. Move detection: establish candidate-count and byte-pressure workload before
   adding bounded file work.

### Move Detection Baseline

`yarn experiment:local-move-detection` creates a disposable project, commits
resolver-compatible synthetic Apex class and metadata pairs, moves the tracked classes directory, and
measures one forced status scan, move detection, normalization commit, and
refreshed status scan. Fixture setup and output serialization are excluded from
the operation. The scenario validates that the final status contains the
expected tracked rows and no changed rows.

`STL_LOCAL_MOVE_CLASS_COUNT` and `STL_LOCAL_MOVE_BYTES_PER_FILE` are
developer-only experiment inputs. They are intentionally not exposed through
STL, CLI, or IDE configuration. If this evidence leads to a production
mitigation, prefer one adaptive internal policy; if an override is unavoidable,
provide a small bounded preset rather than raw candidate-count, byte-budget, or
concurrency controls to IDE users.

The candidate and byte fields are fixture-derived workload descriptors, not
observed physical reads, allocations, or peak memory. The memory snapshots are
operation-boundary snapshots, not peak measurements. On macOS / Node v24.22.1,
with source-tracking bypasses and batch overrides unset, one run of each case
produced:

| Class pairs | Bytes/file | Candidate paths | Candidate content bytes | Wall ms | Longest heartbeat gap ms | Final changed rows |
| ----------- | ---------- | --------------- | ----------------------- | ------- | ------------------------ | ------------------ |
| 100         | 1,024      | 400             | 409,600                 | 307.3   | 20.8                     | 0                  |
| 10          | 1,000,000  | 40              | 40,000,000              | 121.5   | 28.4                     | 0                  |

These are baselines, not performance thresholds or proof of peak-memory use.
They establish that both candidate count and file-byte volume belong in any
future bounded-I/O proposal. Repeat with controlled filesystem/cache conditions
and multiple samples before selecting a production limit or scheduling change.

### Move Detection Repeatability Screen

Five fresh-process samples per cell were collected sequentially on the same
macOS / Node v24.22.1 host, with the scenario's setup-warmed filesystem
condition, no source-tracking bypasses, and no batch-size overrides. Each sample
created a new disposable project and required zero changed rows after
normalization. Values below are raw samples; the summary uses the median and
range, not a cross-run latency percentile.

| Fixture                                  | Candidate paths | Candidate content bytes | Wall ms (raw)                     | Heartbeat gap ms (raw)       | Wall ms median (range) | Heartbeat gap ms median (range) |
| ---------------------------------------- | --------------- | ----------------------- | --------------------------------- | ---------------------------- | ---------------------- | ------------------------------- |
| Apex: 10 classes, 1,024 bytes/file       | 40              | 40,960                  | 76.2, 48.2, 40.4, 37.1, 51.8      | 4.1, 3.6, 3.2, 2.8, 3.4      | 48.2 (37.1–76.2)       | 3.4 (2.8–4.1)                   |
| Apex: 100 classes, 1,024 bytes/file      | 400             | 409,600                 | 294.3, 431.3, 310.6, 291.0, 253.3 | 19.4, 24.5, 21.9, 19.4, 18.1 | 294.3 (253.3–431.3)    | 19.4 (18.1–24.5)                |
| Apex: 10 classes, 10,240 bytes/file      | 40              | 409,600                 | 51.7, 47.7, 39.4, 68.8, 48.0      | 2.9, 3.1, 3.1, 3.8, 3.2      | 48.0 (39.4–68.8)       | 3.1 (2.9–3.8)                   |
| Decomposed object: root + TextArea field | 4               | 970                     | 48.8, 38.7, 21.9, 23.1, 44.0      | 4.5, 2.8, 1.9, 1.9, 2.4      | 38.7 (21.9–48.8)       | 2.4 (1.9–4.5)                   |

The equal-volume Apex comparison is the relevant screening result: 400 candidate
paths had about six times the median wall time and heartbeat gap of 40 candidate
paths. This establishes candidate/path count as the dominant observed pressure
in this complete lifecycle under these conditions. It does not attribute the
cost to hashing, resolver work, status scans, or normalization commit, and does
not select a production threshold.

The next production candidate should therefore investigate one adaptive,
internal bound on move-detection candidate work, preserving all matching and
normalization behavior. It must use measured parity and responsiveness evidence
to choose its bound; it must not expose candidate, byte, or concurrency controls
to IDE users.

### V8-06 Internal Move-Work Bound

V8-06 is that candidate. It uses a fixed internal bound of 32 complete
read-or-blob/hash operations per side, with added files completely processed
before deleted blobs begin. Results retain input order and accumulate linearly.
After each non-final batch, STL yields with `setImmediate`. Metadata resolution
retains one resolver over the complete candidate tree, preserves additions before
deletions, and yields after every 100 complete filename attempts. Collision
maps, exact-match-first comparison, move-and-edit fallback, and normalization
commit remain global, unchanged phases.

The number 32 is an implementation starting point, not a user setting, byte
budget, file-descriptor guarantee, or universal latency limit. The bound is not
exposed through STL, CLI, or IDE configuration. It bounds simultaneously started
candidate operations only; a single large file or resolver call can still be
expensive, and the local tracking lock remains held through the lifecycle.

The 400-candidate-path Apex workload completed with zero changed rows in six
post-change samples. Wall times were 315.5, 280.5, 276.1, 262.8, 283.4, and
273.7 ms; longest heartbeat gaps were 8.8, 11.1, 11.3, 11.9, 12.1, and 7.6 ms.
This improves the pre-change 18.1–24.5 ms heartbeat-gap range, but does not
attribute the improvement to a specific lifecycle phase or establish a
production threshold.

V8-06 hardening adds deterministic direct tests that prove a high-water mark of
32 complete added-file read/hash operations and prove that a second-batch
added-file failure propagates unchanged without starting later candidate batches,
deleted blobs, staging, or commit. A failed batch now waits for every
already-started sibling read/hash to settle before rethrowing the original error
and releasing the local tracking lock. It does not cancel those operations,
start later work, or normalize moves. The lifecycle regression gates 31 sibling
reads after one first-batch failure and proves both the failed status refresh and
a same-project/org local-lock contender remain blocked until all siblings settle.

The scale, binary/image, move-and-edit, same-hash/different-parent, and
decomposed-child move NUTs all pass with V8-06. Five additional fresh-process
400-candidate-path samples all completed with zero changed rows: wall times
267.8, 257.6, 265.5, 264.6, and 271.6 ms (median 265.5; range 257.6–271.6);
longest heartbeat gaps 11.8, 6.5, 6.7, 14.0, and 11.5 ms (median 11.5; range
6.5–14.0). These remain observational results under setup-warmed filesystem
conditions, not a production service-level objective.

### Follow-Up Decisions

Failure-drain semantics for candidate read/hash operations are implemented as
part of V8-06. Draining necessarily delays error propagation and lock release
until the slowest already-started sibling settles. It does not introduce a
timeout, cancellation, or customer-facing setting: such policy would require a
separate filesystem/Git-operation cancellation and lock-timeout design.

IDE-host validation is required separately to evaluate the overall hypothesis
that STL was materially hogging the shared extension-host event loop. It is not
evidence that gates the v8-local improvements above: those have their own
controlled unit, NUT, and same-thread workload evidence. The independent IDE
validation must use a matched consumer workload and distinguish STL time from
watcher/debounce, filesystem, language-server, and unrelated extension work.
It can disprove or bound the initial attribution theory; it must not retroactively
claim that these controlled measurements represent end-to-end IDE latency.

## Out Of Scope

- v9 Effect Git changes.
- Replacing isomorphic-git in this branch.
- Claims that v8 or v9 wins without a matched VS Code Services workload.
