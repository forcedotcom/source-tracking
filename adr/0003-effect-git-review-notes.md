# Effect Git Review Notes

## Purpose

Track findings and open questions while reviewing the replacement of
`isomorphic-git` with the specialized Effect Git implementation. This is a
review record, not an architecture decision.

## Confirmed Context

- The implementation is an independent reimplementation of the limited Git
  operations source tracking needs. It is not a copy or fork of
  `isomorphic-git`; see `src/git/NOTICE.md`.
- The recorded migration rationale identifies event-loop starvation on large,
  deeply nested source projects as the primary problem. The documented causes
  include iso-git's unbounded recursive `Promise.all` walker and synchronous
  content hashing when stat metadata does not match.
- The new implementation bounds filesystem work and exposes it through Effect
  streams. This changes scheduling and concurrency management; Effect does not
  preempt synchronous CPU work by itself.
- Git-compatible SHA-1 content hashing remains necessary. A blob oid is the
  SHA-1 of `blob <size>\0<content>`, so neither implementation can determine
  a blob oid without its framed content bytes. For symlinks, the content is the
  normalized link-target text, not the linked file's contents.
- The replacement uses platform crypto rather than iso-git's possible
  JavaScript `sha.js` fallback. This can avoid that synchronous fallback, but
  does not remove the cost of hashing bytes.

## Cold Forced-Refresh Lifecycle Gap

The Effect rewrite improves the implementation of each local status scan. Its
cold matrix reads the index and HEAD tree, walks configured package roots while
evaluating nested `.gitignore` files, then joins those inputs into status
entries; see `src/git/statusMatrix.ts:238-307`. That per-scan traversal does
not prevent the lifecycle from scanning twice for a cold forced reread.

`reReadLocalTrackingCache()` first calls `ensureLocalTracking()` and then calls
`this.localRepo.getStatus(true)` in `src/sourceTracking.ts:547-550`. When
there is no local repo, `ensureLocalTracking()` creates one and populates its
cache with `localRepo.getStatus()` before publishing it in
`src/sourceTracking.ts:563-573`. Therefore a cold forced reread performs:

```text
create local repo
→ normal status scan to populate the cache
→ forced status scan
```

This duplicates the full local status traversal. It is a lifecycle issue, not
an Effect Git traversal issue.

Port the v8 lifecycle fix before assessing cold-start performance: separate
repo creation from cache population while retaining the shared
`localTrackingInitialization` promise. `reReadLocalTrackingCache()` should
create or await the repo and run exactly one forced scan. `ensureLocalTracking()`
must retain its existing cold-call contract of creating the repo and populating
the normal status cache. Add deterministic regressions for both cold paths and
for concurrent callers not observing a partially initialized repo.

## Effect HashMap And HashSet

`Effect.HashMap` and `Effect.HashSet` replace native mutable `Map` and `Set`
instances in the new implementation. They support immutable collection updates
and Effect stream folds; they are not an event-loop-yielding or hashing
optimization by themselves.

Examples:

- `src/git/applyChanges.ts` models the next index as a path-to-index-entry map,
  deduplicates adds and removes, then writes the resulting index once.
- `src/git/statusMatrix.ts` holds explicit HEAD, index, and worktree state
  maps. Iso-git previously held analogous state internally.
- `src/shared/local/moveDetection.ts` uses maps to match added and deleted
  metadata files by oid and metadata identity.

### Volatility Assessment

Effect 4.0.5 `HashMap` is a persistent hash-array mapped trie (HAMT), not a
full-copy map. An ordinary `HashMap.set` or `HashMap.remove` returns a new map
wrapper and allocates the changed trie path while sharing unchanged structure.
This is normally expected-logarithmic work, but it has more hashing, indirection,
and allocation than an in-place native `Map.set` or `Map.delete`.

Effect exposes `HashMap.mutate`, `beginMutation`, and `endMutation` for a batch
of transient, in-place updates. None of the high-update loops below currently
uses those APIs. `HashSet` has the same persistent-collection concern.

| Location                                            | Collection lifetime and size                                                                                                                                                               | Updates                                                                                                                          | Volatility                                                             | Assessment                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/git/statusMatrix.ts:220-236`                   | One fresh status scan; proportional to every discovered worktree path. Can reach tens or hundreds of thousands of paths.                                                                   | Per path: one `HashSet.add`, one mode-map `HashMap.set`, and one additional untracked-map `HashMap.set` for each untracked path. | High                                                                   | Primary concern. This is a synchronous CPU/allocation-heavy reduction after the filesystem walk. Persistent collection updates are on the hot path and should be compared against native mutable collections or transient Effect collections. |
| `src/git/applyChanges.ts:149-165,197-209`           | One staging operation; proportional to the changed add/remove set, with a second map proportional to the full existing index. The code explicitly anticipates up to 200,000 staged tuples. | One `HashSet.add` per input add/remove, then one `HashMap.set` per staged add.                                                   | High for bulk sync; low for typical small sync.                        | Worth measuring. Filesystem reads, hashing, compression, index writing, and tree construction may dominate, but this collection work scales directly with batch size.                                                                         |
| `src/shared/local/moveDetection.ts:222-240`         | Temporary map proportional to all HEAD tree entries; discarded after move detection.                                                                                                       | Built once, then read-only path lookups.                                                                                         | Build-heavy, then immutable.                                           | The primary concern here is the unnecessary `O(HEAD)` traversal and map retention for sparse candidates. Persistent-map update cost is secondary to that workload mismatch, but it adds allocation to the full materialization.               |
| `src/shared/local/moveDetection.ts:284-345`         | Temporary maps proportional to move candidates and resolved metadata components.                                                                                                           | One or two map updates per candidate during bucketing, then set/map creation for intersection and re-keying.                     | Medium to high for bulk moves; normally small after the basename gate. | Candidate-batch work. It is not on ordinary status scans unless both add and delete candidates share a basename. A transient map or native `Map` could reduce churn in large move batches.                                                    |
| `src/shared/remote/remoteSourceTracking.ts:327-515` | Poll-lifetime map of expected SourceMembers.                                                                                                                                               | One removal per successfully matched member; repeated across poll responses.                                                     | Medium.                                                                | Batches are normally bounded by deployment size and polls are separated by network delay. The more significant algorithmic risk is the fallback scan of all outstanding keys for name-mismatch matching, not persistent-map removal alone.    |
| `src/shared/remote/remoteSourceTracking.ts:583-612` | Timeout-only grouping map keyed by metadata type.                                                                                                                                          | One set per outstanding member while formatting an error.                                                                        | Low.                                                                   | Not a hot success path; no performance action indicated.                                                                                                                                                                                      |

The status scan is particularly important because it creates three persistent
collections incrementally from an empty state. At `N` worktree files it performs
at least `2N` persistent updates and up to `3N` when all files are untracked.
For example, a 100,000-file all-untracked scan performs roughly 300,000
collection updates before it performs the later path-union and status-collapse
work.

### Review Position

Effect-native collections are reasonable at boundaries where immutable snapshots
or algebraic operations improve correctness, but their use should not be assumed
neutral in high-volatility inner loops. The current code has no benchmark that
isolates persistent `HashMap`/`HashSet` construction from filesystem, hashing,
tree parsing, or Effect scheduling overhead.

Before changing implementation, benchmark these equivalent construction paths on
the representative local-status fixtures:

- Current persistent `HashMap`/`HashSet` reduction.
- `HashMap.mutate` and the corresponding transient set approach, retaining an
  immutable Effect collection at the boundary.
- Native mutable `Map`/`Set` used only within the local synchronous reduction,
  converted to the required public representation afterward.

Capture wall time, allocation/GC data, RSS, and event-loop delay at the existing
25,000-, 100,000-, and 255,000-file fixture shapes. Retain Effect collections
where their semantics are valuable and evidence shows no material regression;
otherwise prefer the least-complex mutable local accumulator for the hot loop.

`HashMap.mutate` deserves an explicit benchmark because it may remove the
per-update persistent-map wrapper and trie-path allocation while retaining an
Effect `HashMap` at the boundary. Conceptually it is a **confined transient
batch**, not a transaction: it enables in-place updates during a synchronous
callback and then finalizes the same map as immutable. It does not provide
rollback, isolation, concurrent access control, or atomic commit semantics.
The callback must not leak the transient collection or use it across an
asynchronous boundary. Its functional-model cost is therefore part of the
comparison, alongside its measured performance.

### Alternative: `data-structure-typed`

`data-structure-typed` version 2.6.3 was reviewed as a possible mutable
alternative. It is MIT licensed, has no runtime dependencies, and exposes a
tree-shakeable `data-structure-typed/hash` subpath. Its `HashMap` does not use
the JavaScript engine's native `Map` for string and number keys: it stores those
keys in a normal object record and reserves native `Map` for object/function
keys.

```ts
protected _store: { [key: string]: HashMapStoreItem<K, V> } = {};
protected _objMap: Map<object, V> = new Map();
```

The Apex language server provides directly relevant production evidence that
this design can outperform Effect's persistent `HashMap` for its high-churn
workloads. It uses DTS maps as mutable data owned by Effect `Ref`s for symbol
indexes, file-state stores, document caches, and symbol tables. For example,
`packages/apex-parser-ast/src/symbols/services/symbolIndexStoreLive.ts` mutates
DTS maps within `Ref.update`; it keeps Effect for lifecycle and concurrency,
without paying persistent-collection allocation for every index update.

That is an applicable architectural precedent for source tracking's local
accumulators. The generic package benchmark is not sufficient to predict this
repository's workload, but it also cannot override measured language-server
results on similarly Effect-oriented, update-heavy code.

The following implementation and compatibility questions remain:

- Its published 1,000,000-entry `HashMap.set` benchmark is 146.17 ms versus
  144.83 ms for native `Map`; this is parity within benchmark noise, not a
  general-purpose advantage over native `Map`. The relevant comparison here is
  DTS versus Effect persistent collections, not DTS versus native `Map` alone.
- Every string-key operation goes through custom key conversion and a wrapper
  object `{ key, value }`, whereas native `Map` stores the key and value
  directly.
- The primitive-key backing store is `{}`, not `Object.create(null)`. A
  path-derived key such as `__proto__` can interact with inherited object
  properties or the legacy prototype setter. Git paths and metadata keys should
  not be routed through that representation without a library fix and explicit
  adversarial tests.
- The published package is 2.3 MB compressed and 11.0 MB unpacked. The hash
  subpath is materially smaller than the full package, but adding a third-party
  collection dependency still needs an evidence-based payoff.

**Current recommendation:** include DTS in the source-tracking comparison rather
than rejecting it from generic package inspection. Benchmark four equivalent
implementations for the status and bulk-staging accumulators: current Effect
persistent collections, Effect transient mutation, native `Map`/`Set`, and DTS
`HashMap` plus a compatible mutable set strategy. Use the installed version
validated by the language server, currently `2.6.4`, and import the hash
subpath rather than the full package.

Adoption should require source-tracking-specific evidence: equivalent results,
wall time, allocation/GC, RSS, bundle impact, and event-loop delay on the
existing representative fixtures. Add explicit tests for path-like special keys
such as `__proto__`, `constructor`, and `toString` before storing untrusted or
filesystem-derived paths in the DTS map. If those tests expose the object-store
behavior, prefer native `Map` for that boundary or obtain a DTS fix rather than
silently accepting divergent key semantics.

## Move Detection Trade-Off

### Previous behavior

For every candidate deleted path, the iso-git implementation invoked
`git.readBlob` with the HEAD oid and file path. It was a targeted lookup, but
each call still had to resolve that path through the Git tree hierarchy.

### Current behavior

`drainHeadOids()` in `src/shared/local/moveDetection.ts` walks all entries in
the HEAD tree, creates a temporary `HashMap<path, oid>`, and looks up candidate
deleted paths in that map. The map is local to one move-detection operation and
is discarded when that operation completes.

The tree walk reads commit and tree objects to enumerate paths and oids. It
does not read, inflate, or rehash every blob's content.

### Benefit

For a large batch of deleted candidate paths, one tree traversal avoids many
independent path resolutions and provides efficient lookups for all candidates.

### Cost and Risk

The operation is `O(N)` in HEAD tree entries and retains `O(N)` temporary map
state, even when only one deleted candidate needs an oid. The basename gate
avoids move detection unless additions and deletions share a basename, but one
add/delete pair is sufficient to trigger the full materialization.

This may penalize a common incremental move or rename case in a large project:

```text
one deleted path + one same-basename added path -> enumerate full HEAD tree
```

The checked-in benchmarks demonstrate the large-scale behavior but do not
establish the crossover point at which full traversal beats targeted lookup for
sparse deletes.

## Open Questions

- What are the observed distributions of candidate deleted paths when move
  detection runs in customer projects?
- What are the latency and allocation costs for one, a few, and many candidate
  deletes at representative HEAD sizes and directory shapes?
- What threshold makes a targeted per-path lookup preferable to a full tree
  traversal?
- Could a multi-path, prefix-pruned tree walk preserve shared traversal work
  without enumerating unrelated tree entries?
- Should the HEAD path-to-oid map be cached, and if so, how is it invalidated
  after `applyChanges` advances HEAD?

## Candidate Follow-Ups

- Add a benchmark matrix for sparse and bulk move-detection candidates against
  small, medium, and large shadow repositories.
- Measure tree-entry count, deleted-candidate count, wall time, event-loop
  delay, and allocation or RSS impact.
- Compare three strategies: targeted path resolution, full HEAD traversal, and
  a threshold-based hybrid.
- Make a design decision only after the workload and crossover evidence is
  available.

## Measured Local-Status Performance Position

The existing local-status benchmark ledger does not support a general claim
that the Effect Git implementation is slower than isomorphic-git. It shows a
fixture-shape crossover:

- On the completed 2,550-, 5,100-, and 10,050-file forced zero-change
  fixtures, Effect Git is 33-43% slower. A one-file edit remains 46% slower,
  so the scan cost occurs before final changed-path selection.
- At roughly equal volume (about 25,500 files), it is at parity for 50x500 and
  100x250 object/field shapes, but 26.7% slower for the broader 500x50 shape.
- The repeated high-object-count curve crosses from 0.7% slower at 750x50 to
  4.9% faster at 1,000x50 and 17.6% faster at 2,000x50. The single 5,000x50
  feasibility probe is 66.2% faster, but is not a stable tail-latency result.

The instrumented candidate phases attribute the broad-directory regression to
tracked-file hashing and HEAD-tree traversal, not the worktree walk:

| Equal-volume shape       |   Hashing | HEAD tree | Worktree walk | Matrix preparation |
| ------------------------ | --------: | --------: | ------------: | -----------------: |
| 50 objects x 500 fields  | 442.72 ms | 221.30 ms |     296.73 ms |           67.10 ms |
| 100 objects x 250 fields | 450.29 ms | 250.13 ms |     304.81 ms |           69.45 ms |
| 500 objects x 50 fields  | 671.20 ms | 408.77 ms |     309.36 ms |           78.64 ms |

The recursive walker does create one `Effect.forEach` per observed directory
and flattens recursive result arrays in `src/git/dirWalk.ts`, so its scheduler
and allocation costs remain an implementation hypothesis. However, the phase
measurements keep its wall time nearly flat across the equal-volume shape
curve. Do not prioritize a walker rewrite ahead of the measured hash/tree
phases without a finer profiler showing otherwise.

### Remaining Hot-Path Candidates

These are ranked as benchmark targets, not confirmed regressions.

1. **HEAD tree parse and materialization.** `src/git/trees.ts` parses every
   tree entry, converts every 20-byte oid with `Array.from(...).join('')`,
   validates it with `Schema.decodeUnknownSync(Oid)`, validates the constructed
   path with `Schema.decodeUnknownSync(RepoPath)`, streams it, collects the
   entire stream, then builds `headByPath`. This is directly inside the
   measured HEAD-tree phase and incurs per-entry arrays, strings, schemas, and
   stream elements. Benchmark an equivalent trusted internal representation
   with validation at the untrusted object boundary and typed construction for
   values already validated by the parser. Preserve malformed-object error
   behavior and public brands before adopting it.
2. **Tracked-file blob hashing.** `src/git/objects.ts` creates a new framed
   `Uint8Array` for every `blob <size>\0<content>` hash, submits it through
   the Effect `Crypto` service, hex-encodes the digest with another
   `Array.from(...).join('')`, then validates the oid schema. Git framing and
   digesting are non-optional, but the extra buffer and conversions may matter
   at the measured 2,000- and 5,000-object scales. Compare the current
   cross-platform implementation with a semantically identical incremental or
   no-copy framing approach only if the target runtimes provide one; do not
   replace the platform-crypto contract merely to optimize Node.
3. **Persistent local-status indexes.** The high-volatility
   `HashMap`/`HashSet` assessment above remains relevant. Matrix preparation is
   a smaller measured phase than hashing and tree traversal, but it grows from
   67.10 ms to 78.64 ms across the equal-volume breadth curve and reaches
   404.67 ms at 2,000x50. Test mutable/transient accumulators as a separate
   experiment so their outcome is not conflated with tree or hash work.
4. **Per-file Effect construction.** Current hot helpers are appropriately
   `Effect.fnUntraced`; commit `268749a` removed per-item traced spans after
   measurement. Bounded `Stream.mapEffect` and `Effect.forEach` still create
   Effect/fiber scheduling work for each tracked hash and directory entry. This
   should be profiled as framework overhead within the existing hash/tree
   phases, not assumed from source inspection. It may be the price of the
   bounded-concurrency behavior that avoids the original event-loop starvation.

`Chunk.append` in `scanStatus` is not an equivalent full-scan accumulator:
it only receives emitted added, modified, or deleted results after status
evaluation. Its persistent concatenation overhead should be measured for very
large change result sets, but it is not a leading explanation for zero-change
status latency. The analogous remote polling and timeout formatting paths are
also not local-status optimization targets without remote-specific evidence.

### Recommended Attribution Matrix

Extend the existing `SF_STL_STATUS_PROFILE` runs on LS-01, LS-07, and LS-08
with allocation sampling or CPU profiles for each row below. Keep the current
correctness assertions and run candidate variants sequentially on the same
host and fixture state.

| Experiment                            | Isolates                                                                             | Decision rule                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tree parse/materialize microbenchmark | oid hex conversion, schema decoding, Stream collect, and `headByPath` construction   | Change representation only if it preserves corrupt-tree failures and improves the measured HEAD-tree phase at broad and high-object shapes. |
| Blob hash microbenchmark              | framing allocation, crypto submission, digest hex encoding, and oid validation       | Retain the platform implementation unless a compatible alternative improves end-to-end hashing and does not worsen event-loop delay.        |
| Status-index accumulator comparison   | Effect persistent, `HashMap.mutate`, native `Map`/`Set`, and DTS mutable collections | Select the least-complex representation with a repeatable wall-time/allocation benefit and identical status results.                        |
| Trace/runtime comparison              | operation-level tracing, `fnUntraced`, and scheduler overhead                        | Do not reintroduce per-item spans. Treat tracing changes as valid only when they preserve useful operation-level visibility.                |

The evaluation must record wall time, max event-loop delay with a validated
sampler, allocation/GC, and peak or sampled RSS. Separate CPU profiles are
needed because concurrent phase timers do not sum to the public operation wall
time.

### Measured OID Hex-Encoding Result

The first low-risk OID experiment replaced the three duplicate
`Array.from(bytes, ...).join('')` implementations in `objects.ts`,
`indexV2.ts`, and `trees.ts` with shared `bytesToHex()` in `src/git/bytes.ts`.
The helper uses a precomputed 256-entry lowercase hex table and a single
synchronous pass, avoiding the intermediate array and one two-character string
per source byte.

This preserves Git compatibility: the digest algorithm remains SHA-1, on-disk
index/tree OIDs remain 20 bytes, and the resulting internal/public `Oid` values
remain the exact canonical lowercase 40-hex-character strings. It is not an
internal binary-OID representation redesign.

On one retained 2,000-object x 50-field fixture (102,000 source files), three
sequential, alternating forced zero-change `reReadLocalTrackingCache()` runs
produced the following end-to-end wall-clock results:

| Run    | Existing per-call encoder | Shared table encoder |    Improvement |
| ------ | ------------------------: | -------------------: | -------------: |
| 1      |                  9,108 ms |             8,826 ms |         282 ms |
| 2      |                  9,055 ms |             8,524 ms |         531 ms |
| 3      |                  8,995 ms |             8,678 ms |         317 ms |
| Median |                  9,055 ms |             8,678 ms | 377 ms (4.16%) |

All adjacent pairs favored the shared encoder. Focused Git object, index, and
tree suites passed (29 tests), including known Git OID fixture assertions and
40,000-entry index/tree parser cases. Retain this change. A future internal
binary-OID representation can preserve Git compatibility if it still computes
SHA-1 over Git framing and converts to canonical 40-hex strings at all external
and on-disk boundaries; it should be evaluated separately from this encoding
improvement.

### Measured Tree Path Validation Result

`streamHeadTreeWithMode()` previously decoded `RepoPath` for every completed
path as recursive tree prefixes were reattached. The replacement validates each
raw tree-entry basename once during parsing, explicitly rejects `/` because a
tree entry must be a basename, and treats a valid parent plus valid basename as
a valid `RepoPath` during recursive composition. This retains the public path
type and malformed-tree failure boundary while avoiding repeated schema decodes
for constructed descendants.

On the same retained 2,000-object x 50-field fixture (102,000 source files),
three sequential, alternating forced zero-change `reReadLocalTrackingCache()`
runs produced:

| Run    | Recursive path decode | Validated-segment composition |    Improvement |
| ------ | --------------------: | ----------------------------: | -------------: |
| 1      |              8,273 ms |                      7,135 ms |       1,138 ms |
| 2      |              7,501 ms |                      7,820 ms |        -319 ms |
| 3      |              7,487 ms |                      7,249 ms |         238 ms |
| Median |              7,501 ms |                      7,249 ms | 252 ms (3.36%) |

The full operation remains noisy, but two of three paired samples and the
median favor validated-segment composition. Focused objects, index, and tree
suites passed (30 tests), including a synthetic tree entry named `.` that must
continue to fail as an `ObjectCorruptError`. Retain this change; it is separate
from the OID encoding improvement.

### Measured OID Schema Decode Result

The index and tree parsers both previously hex-encoded a bounds-checked
20-byte OID and then decoded the derived 40-character lowercase string through
the `Oid` schema. A 20-byte byte sequence necessarily produces a valid OID
through `bytesToHex()`, so the redundant parser-local schema decode was
replaced with a typed internal construction. External OID strings, object
identity, and corrupt-index/tree checks remain unchanged.

On the retained 2,000-object x 50-field fixture, sequential alternating
forced zero-change runs measured:

| Run    | Schema decode | Typed construction |    Improvement |
| ------ | ------------: | -----------------: | -------------: |
| 1      |      7,550 ms |           7,501 ms |          49 ms |
| 2      |      7,731 ms |           7,249 ms |         482 ms |
| 3      |      7,721 ms |           7,714 ms |           7 ms |
| Median |      7,721 ms |           7,501 ms | 220 ms (2.85%) |

Every paired sample favored typed construction. Focused index and tree suites
passed (19 tests), including corrupt-index checks and malformed-tree parsing.
Retain this narrow invariant-based optimization.

### Schema Decode Measurement And Boundary

A direct runtime probe ran the current compiled decoders against 102,000 valid
paths matching the generated local-status fixture shape. `RepoPath`
`Schema.decodeUnknownSync` took approximately 55 ms, `Oid`
`Schema.decodeUnknownSync` took approximately 21 ms, and the same iteration
without decoding took approximately 0.5 ms. Schema decoding is therefore
measurable at large scale, but does not dominate a 7–9 second complete
zero-change status scan on its own.

Retain `RepoPath` decoding at `statusMatrix.collapse()` for now: index and
workdir paths reach that common boundary without earlier `RepoPath` validation.
Moving that validation requires explicit validation at every untrusted
ingestion boundary and a trusted internal-path type; do not replace it with an
unchecked cast merely for speed. Retain full `Oid` decoding for refs, public
inputs, and decoded commit headers. The parser-local OID optimization above is
safe only because its source has already been bounds-checked to exactly 20
bytes and `bytesToHex()` deterministically produces a canonical lowercase
40-hex-character OID.

## Measured Matrix Subphases

An opt-in, temporary timer probe ran against the retained 2,000-object x
50-field fixture. It was removed after measurement so production status scans
do not carry profiling branches. The profiled forced zero-change scan took
7,632 ms; the second scan within the same profiler invocation reported these
serial phases:

| Phase                                   |     Time |
| --------------------------------------- | -------: |
| Read and parse index                    |   131 ms |
| Resolve, parse, and collect HEAD tree   | 1,449 ms |
| Materialize HEAD-path map               |   157 ms |
| Walk workdir                            | 1,542 ms |
| Build workdir indexes from walk results |   401 ms |
| Evaluate the complete status matrix     | 3,602 ms |

The serial phase total is 7,282 ms, leaving about 350 ms (4.6%) of the public
wall time for exclude-file reading, bare-file-root handling, stream consumption,
outer filtering/folding, cache/telemetry/runtime work, timer overhead, and
measurement noise. The earlier partial timing was not sufficient to explain the
wall time and must not be used as a complete breakdown.

Within the complete matrix evaluation, a prior subphase probe reported about
400 ms to build workdir indexes, 400 ms for path union/filter/sort, 200 ms for
partitioning, and 2.9 seconds to hash tracked files and collapse cells. These
numbers are directional only because they came from a separate run; collection
representation changes still require a repeatable end-to-end benefit.

### Event-Loop Delay Probe

A separate temporary `monitorEventLoopDelay({ resolution: 10 })` probe measured
the same fixture. It was also removed after the run. The profiled refresh had a
7,151 ms wall time and reported the following phase-local delay values:

| Phase                                 | Wall time | p99 delay | Max delay |
| ------------------------------------- | --------: | --------: | --------: |
| Read and parse index                  |    142 ms |   14.0 ms |   14.0 ms |
| Resolve, parse, and collect HEAD tree |  1,318 ms |   13.1 ms |   14.4 ms |
| Walk workspace                        |  1,482 ms |   17.8 ms |   29.9 ms |
| Evaluate matrix                       |  3,406 ms |   14.9 ms |   35.1 ms |

The sampler's 10 ms resolution limits the precision of this result. It does,
however, rule out multi-second event-loop stalls in these phases on this host
and fixture: asynchronous filesystem work is yielding often enough for timers
to run. The largest observed delay was 35.1 ms during matrix evaluation, and
29.9 ms during the workspace walk. Continue to treat synchronous parsing,
collection construction, sorting, and hashing as candidates for a tighter
sampler or production event-loop SLO; this probe does not prove they are free
of shorter stalls.

### Rejected HEAD Prefix Propagation Experiment

`buildStream()` was experimentally changed to carry each full prefix into its
recursive `readTree()` call, rather than reconstructing a descendant path at
each ancestor as entries stream back upward. The change preserved the nested
tree's depth-first order and passed focused tree parser and corrupt-object
tests, but it did not establish a meaningful end-to-end improvement.

On consecutive runs of the retained 2,000-object x 50-field fixture, the
prefix-downward candidate took 8,663 ms and the original upward reconstruction
took 8,839 ms. The apparent 176 ms difference is smaller than normal run
variation observed on this host, so the experiment was reverted. Do not retain
this allocation-only change without a lower-variance tree-local benchmark.

### Next Task: Git-Compatible Stat Cache

The next optimization candidate is a Git-style stat cache for unchanged
workspace files. It should be implemented and reviewed as a separate,
correctness-sensitive change rather than mixed with traversal experiments.

Required design and implementation work:

- Define the workspace stat snapshot retained from `lstat` and the index fields
  required for a safe match: size, mtime, ctime, device, inode, and Git mode.
- Bind index timestamp provenance to the exact `.git/index` bytes parsed; reject
  an observation if the index can have been replaced while it was being read.
- Define conservative timestamp normalization for the current on-disk u32
  index representation and supported filesystems.
- Carry the required workspace stat snapshots through the directory walk while
  preserving bounded I/O, symlink behavior, ignored-file classification, and
  disappearance handling.
- Reuse an index blob OID only for a supported stage-0 entry whose workspace
  snapshot matches and whose cached mtime is strictly older than the timestamp
  of that same index version.
- Continue with the existing content-read and Git SHA-1 path for every stat
  mismatch, unsupported file type, uncertain observation, or racy entry.
- Do not use `assumeValid` as an optimization shortcut; honoring it would alter
  source-tracking's current detection contract.
- Add writer-side racy-entry protection when an unrelated synchronization
  rewrites the index, so a previously uncertain same-size edit cannot become
  trustworthy merely because the index timestamp advanced.

Required deterministic correctness coverage:

- An old, unchanged regular file reuses the index OID without a workdir content
  read or hash.
- Touch-only and same-content inode-replacement cases fall back to hashing and
  remain unmodified.
- Different-size and same-size dirty edits report modified.
- A same-size edit at the racy timestamp boundary hashes and reports modified.
- An unrelated index rewrite after a potentially racy edit still reports that
  edit as modified.
- Executable-bit changes and regular-file-to-symlink replacement report
  modified.
- Symlink target changes, dangling links, and destination-only changes preserve
  current link-target semantics.
- Empty files, zero or unavailable stat fields, deleted paths, and bare-file
  roots fall back safely.

Acceptance requires alternating A/B runs on the retained 2,000-object x
50-field fixture. Record identical status output plus end-to-end and
matrix-phase wall time, content-read/hash counts, CPU/heap profiles, and
event-loop delay. Retain the change only for a repeatable improvement.

Deferred work:

- Do not revisit `.gitignore` precheck removal unless a fixture with material
  `.gitignore` density demonstrates a benefit.
- Do not change tree-object integrity verification, decompression, traversal
  concurrency, or workspace I/O concurrency without separate measurements and
  correctness review.

The next viable optimization experiment is Git-style stat-cache reuse. The
index already persists ctime, mtime, device, inode, mode, and size in
`IndexEntry.stat`; `stageAdd()` records those values when it writes a blob.
The walker currently discards all of that data except mode, so every tracked
present file is read and SHA-1 hashed again. A safe implementation would carry
the necessary stat snapshot from the existing `lstat` through the walk and
reuse the index OID only for a proven stat match.

This is not a trivial shortcut: it must preserve Git's racy-clean protection,
including files whose timestamp could be indistinguishable from the index write
or whose metadata matches after a same-size edit. It also needs explicit
coverage for regular-file edits, executable-bit changes, symlinks, deletions,
and a forced timestamp collision. Until those rules and tests exist, retain
content hashing as the correctness baseline.

The DTS and other mutable-collection experiments were tested and rejected: they
did not provide a repeatable end-to-end improvement. The earlier lockfile
blocker no longer applies; do not add DTS solely to revisit an already-negative
experiment.

## References

- `src/git/NOTICE.md`
- `src/git/objects.ts`
- `src/git/workdir.ts`
- `src/git/applyChanges.ts`
- `src/git/statusMatrix.ts`
- `src/git/trees.ts`
- `src/shared/local/moveDetection.ts`
- `src/shared/local/localShadowRepo.ts`
- `test/perf/PERFORMANCE_BENCHMARKS.md`
- Historical rationale: `git show 1ddb322:isogit-migration.md`
