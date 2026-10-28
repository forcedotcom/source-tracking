# Source Tracking Performance Benchmarks

## Purpose

This ledger records reproducible performance evidence for source-tracking changes. It is the shared decision record for benchmark setup, raw summaries, validity notes, and conclusions.

The current comparison is between the current isomorphic-git implementation and PR #888's specialized Effect shadow-repository implementation. The goal is better STL customer behavior, not general Git compatibility or byte-identical isomorphic-git internals.

## Rules

- Compare one operation at a time. Do not combine local filesystem work with deploy, retrieve, or SourceMember polling unless that is the scenario under test.
- Use the same host, Node version, fixture content, and run count for both implementations.
- Keep one fixture project and `.sf` shadow directory per implementation. Never point a candidate implementation at a baseline project, or vice versa.
- Record the implementation revision, fixture shape, operation, run count, and all summary values.
- Discard contaminated runs. Remove the affected fixture project's `.sf` directory before recreating its baseline with the correct implementation.
- Record STL-visible correctness alongside performance for scenarios that introduce changes, moves, or deletes.

## Fixture Profiles

`yarn experiment:gen-fixture` creates source in a disposable SFDX project.

| Profile   | Shape                                 | Intended measurements                                                  |
| --------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `apex`    | Flat Apex classes and tests           | Deploy timing and SourceMember polling                                 |
| `objects` | Decomposed Custom Objects with fields | Local status, reset, sync, and move detection                          |
| `mixed`   | Both profiles                         | Mixed customer-project shape once individual dimensions are understood |

For local shadow measurements, the file count is `objects × (fields per object + 1 object metadata file)`.

## Shared Local-Status Protocol

`yarn experiment:local`:

1. Creates `SourceTracking`; the org supplies the org-scoped shadow path only.
2. Calls `resetLocalTracking()` outside the timed loop to establish the source fixture as baseline.
3. Repeats `reReadLocalTrackingCache()` and reads local non-delete changes.
4. Records elapsed time for each forced zero-change local status scan.

The timed loop contains no Salesforce API call, deploy, retrieve, SourceMember polling, remote tracking, move matching, or `recordSync`.

## Benchmark Matrix

| ID    | Scenario                      | Fixture                                                            | Operation                                             | Status                                                              |
| ----- | ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| LS-01 | Decomposed baseline           | 50 objects × 50 fields = 2,550 files                               | Forced zero-change local status                       | Complete                                                            |
| LS-02 | File-count scaling            | 100 objects × 50 fields = 5,100 files                              | Forced zero-change local status                       | Complete                                                            |
| LS-03 | Child-directory width scaling | 50 objects × 200 fields = 10,050 files                             | Forced zero-change local status                       | Complete                                                            |
| LS-04 | Incremental field edit        | LS-01 plus one changed field                                       | Local status and exact changed path                   | Complete                                                            |
| LS-05 | Decomposed child move         | LS-01 plus one field moved between objects                         | Move detection and resulting status                   | Complete                                                            |
| LS-06 | Large sync                    | 50 objects × 250 fields = 12,550 files; 250 adds + 250 deletes/run | `updateLocalTracking`, index/tree write, clean status | Complete                                                            |
| LS-07 | Equal-volume shape curve      | Approximately 25,500 decomposed files at three object/field ratios | Forced zero-change local status                       | Complete: sequential 10-run legs                                    |
| LS-08 | High object-count curve       | 2,000 and 5,000 objects with 50 fields each                        | Forced zero-change local status                       | Complete: 2,000-object 3-run leg and 5,000-object feasibility probe |
| RP-01 | Flat remote poll              | Fresh scratch org seeded with generated Apex classes               | `updateRemoteTracking` poll and sync                  | Preliminary: one isolated leg/implementation                        |
| RP-02 | Decomposed remote update      | Object profile deployed to scratch org                             | Remote update/poll and local reconciliation           | Preliminary: one valid pair; repeat instability under investigation |

## Results

Environment for all valid local-status comparisons: Node `v24.18.0`, same macOS host, source-tracked scratch org `00Dhs000001uALvEAM`, 30 runs per leg, separate fixture `.sf` directories.

| ID    | Implementation         | Median ms | Min ms | Max ms |    Delta | Correctness                     |
| ----- | ---------------------- | --------: | -----: | -----: | -------: | ------------------------------- |
| LS-01 | Current isomorphic-git |     84.82 |  81.42 | 109.82 | baseline | 0 local changes after baseline  |
| LS-01 | PR #888 Effect Git     |    121.51 | 115.68 | 173.91 |   +43.3% | 0 local changes after baseline  |
| LS-02 | Current isomorphic-git |    180.07 | 173.47 | 198.82 | baseline | 0 local changes after baseline  |
| LS-02 | PR #888 Effect Git     |    239.68 | 228.80 | 285.29 |   +33.1% | 0 local changes after baseline  |
| LS-03 | Current isomorphic-git |    332.50 | 311.23 | 381.49 | baseline | 0 local changes after baseline  |
| LS-03 | PR #888 Effect Git     |    440.78 | 414.45 | 521.89 |   +32.6% | 0 local changes after baseline  |
| LS-04 | Current isomorphic-git |     81.96 |  76.63 |  91.55 | baseline | exactly one expected field path |
| LS-04 | PR #888 Effect Git     |    119.80 | 113.06 | 147.99 |   +46.2% | exactly one expected field path |

LS-01 uses the median of two valid 30-run legs per implementation. LS-02 and LS-03 currently use one valid sequential 30-run leg per implementation. The candidate minimum exceeded the baseline median in every completed scenario, so the observed regression is not an isolated outlier.

## LS-01 Interpretation

The Effect candidate's forced scan performs explicit index parsing, HEAD tree traversal/parsing, worktree walking and `lstat`, map construction, tracked-file hashing, sorting, and status collapse. The benchmark establishes a regression but does not attribute it to one phase.

Before optimizing, add phase timings for index read, HEAD tree traversal, worktree walk, file hashing, and status collapse. Then repeat LS-01 and the scaling scenarios.

## Scaling Interpretation

LS-02 doubles LS-01's object count while retaining 50 child fields per object. LS-03 retains 50 object directories but widens each child directory to 200 fields. Both scenarios show a persistent candidate regression, so the LS-01 result is not limited to one small fixture shape.

The percentage regression is lower at larger sizes, but absolute delay grows from 36.69 ms in LS-01 to 59.61 ms in LS-02 and 108.28 ms in LS-03. This is evidence for phase-level attribution, not evidence that the candidate scales acceptably.

The first LS-02 and LS-03 legs were run concurrently and are excluded from this table because they contended for host filesystem and CPU resources. Only the later sequential 30-run legs are recorded.

## Incremental Edit Interpretation

LS-04 changes one generated CustomField after the fixture is recorded as baseline. Both implementations reported exactly `force-app/main/default/objects/StlPerfObject00__c/fields/Field00__c.field-meta.xml` and no other local changes. The candidate regression persists even when the result set is one file, which supports the hypothesis that the expensive work precedes final changed-file selection.

## Designed Scenarios

LS-05 establishes the LS-01 baseline, moves `MoveCandidate__c.field-meta.xml` from `StlPerfObject00__c` to `StlPerfObject01__c`, then measures a forced status refresh. Existing STL coverage specifies that a moved decomposed child remains an add plus delete rather than an auto-committed Git-style rename. Each implementation reported exactly the expected old and new paths for both 30-run legs.

| Scenario | Fixture                                     | Current implementation median | PR #888 median       | Delta  |
| -------- | ------------------------------------------- | ----------------------------- | -------------------- | ------ |
| LS-05    | 50 objects x 50 fields plus one moved child | 92.35 ms, 88.21 ms            | 162.81 ms, 161.48 ms | +79.6% |

LS-05 used separate fresh fixture projects and implementation-specific `.sf` state. Environment: Node `v24.18.0`, same host and source-tracked org, 30 sequential forced scans per leg. The representative medians are 90.28 ms current and 162.15 ms PR #888.

LS-06 establishes a 12,550-file object-profile baseline, then alternates 250 existing field deletions with 250 field additions for 30 runs. Each iteration times the public `updateLocalTracking()` call, then forces a status refresh and asserts zero deletes and zero nondeletes. The batch is 500 files (4.0% of the whole fixture), selected to provide a substantial sync update while allowing repeated alternating runs over the same stable fixture shape.

| Scenario                      | Current implementation median | PR #888 median       | Delta  | Correctness                    |
| ----------------------------- | ----------------------------- | -------------------- | ------ | ------------------------------ |
| LS-06, 250 adds + 250 deletes | 3630.50 ms, 3744.64 ms        | 683.28 ms, 688.30 ms | -81.4% | Both legs: forced status clean |

LS-06 used dedicated paired fixture projects with implementation-specific `.sf` state, Node `v24.18.0`, the same host and source-tracked org, and 30 sequential updates per leg. Representative medians are 3687.57 ms current and 685.79 ms PR #888. Median per-run RSS deltas were 163,840 and 999,424 bytes current versus 704,512 and 573,440 bytes PR #888; these are process-level deltas rather than a peak-memory measurement.

## LS-07: Equal-Volume Shape Curve

LS-07 holds the total decomposed source volume approximately constant at 25,500 files and varies the object-directory count versus fields per object. Each implementation used a distinct generated project and `.sf` state. Legs were run sequentially, 10 forced zero-change scans per implementation, on Node `v24.18.0` and the same macOS host. The source-tracked sandbox identity only supplies the org-scoped shadow path; this benchmark makes no deploy or remote API call. All legs finished with zero local changes.

| Shape                    |  Files | Current median ms | Effect median ms |  Delta |
| ------------------------ | -----: | ----------------: | ---------------: | -----: |
| 50 objects x 500 fields  | 25,050 |          1,173.84 |         1,153.21 |  -1.8% |
| 100 objects x 250 fields | 25,100 |          1,199.94 |         1,195.64 |  -0.4% |
| 500 objects x 50 fields  | 25,500 |          1,212.51 |         1,536.72 | +26.7% |

The wide and middle shapes are effectively at parity, while the many-object shape is the worst observed local-status case for the Effect candidate. This is a shape regression rather than a total-file-count regression: adding 450 object directories at approximately fixed volume increases candidate latency by 383.51 ms, versus 38.67 ms current.

Candidate phase medians for the same curve:

| Shape     | Hashing ms | HEAD tree ms | Worktree walk ms | Index read/parse ms | Matrix preparation ms |
| --------- | ---------: | -----------: | ---------------: | ------------------: | --------------------: |
| 50 x 500  |     442.72 |       221.30 |           296.73 |               35.40 |                 67.10 |
| 100 x 250 |     450.29 |       250.13 |           304.81 |               36.62 |                 69.45 |
| 500 x 50  |     671.20 |       408.77 |           309.36 |               38.96 |                 78.64 |

The worktree walk stays nearly flat across these equal-volume shapes. The candidate's hashing and HEAD-tree traversal grow sharply with object-directory count and account for the regression. The candidate phases were measured with `SF_STL_STATUS_PROFILE=true`; profiling is diagnostic-only and its phase timings are not expected to sum exactly to wall-clock time because portions run concurrently and uninstrumented framework overhead remains.

The earlier concurrent endpoint runs are excluded: simultaneous current and candidate scans contended for host filesystem and CPU resources. Only the sequential values above are used for conclusions.

## LS-08: High Object-Count Curve

LS-08 keeps the 50-field-per-object shape that exposed the 25k-file breadth regression and increases the number of independently decomposed object directories. These are local-source fixtures only: their file counts are unrelated to Metadata API or SDR deploy component limits, because the benchmark performs no deployment. The source-tracked sandbox identity only provides an org-scoped shadow directory.

| Shape                     | Local decomposed files |              Current result |               Effect result |  Delta | Confidence                                     |
| ------------------------- | ---------------------: | --------------------------: | --------------------------: | -----: | ---------------------------------------------- |
| 500 objects x 50 fields   |                 25,500 | 1,212.51 ms median, 10 runs | 1,536.72 ms median, 10 runs | +26.7% | Stable endpoint                                |
| 750 objects x 50 fields   |                 38,250 |  2,049.75 ms median, 3 runs |  2,064.29 ms median, 3 runs |  +0.7% | Near parity                                    |
| 1,000 objects x 50 fields |                 51,000 |  2,905.04 ms median, 3 runs |  2,762.56 ms median, 3 runs |  -4.9% | Crossover endpoint                             |
| 2,000 objects x 50 fields |                102,000 |  8,177.49 ms median, 3 runs |  6,737.51 ms median, 3 runs | -17.6% | Directional: candidate has one 11.39 s outlier |
| 5,000 objects x 50 fields |                255,000 |         52,623.22 ms, 1 run |         17,768.54 ms, 1 run | -66.2% | Feasibility probe only; not a stable median    |

The observed crossover is bracketed between 750 and 1,000 objects: Effect is 14.54 ms slower at 750 objects and 142.48 ms faster at 1,000. Linear interpolation of that local difference estimates parity near 773 objects, but this is an interpolation rather than a predictive threshold. At 102k files, both implementations are customer-materially slow, but the candidate has a 1.44 s median improvement. At 255k files, the current implementation takes 52.62 s for the single measured zero-change refresh while the candidate takes 17.77 s. The one-run 255k values establish that this scale is feasible and that the candidate's high-object-count curve is substantially better; repeat each at least twice before making a tail-latency claim.

For the repeated 500-to-2,000-object points, a log-log least-squares fit (`time = a * objects^b`) gives an effective exponent of `b = 1.38` for current (`R² = 0.998`) and `b = 1.08` for Effect (`R² = 0.983`). This supports **superlinear** local-status growth for current and **near-linear** growth for Effect over this measured interval. It does not establish a global asymptotic complexity or an exponential function: segment exponents vary by interval, and the 5,000-object point has only one sample.

Candidate phase values at the high-object points:

| Shape                   | Hashing ms | HEAD tree ms | Worktree walk ms | Index read/parse ms | Matrix preparation ms |
| ----------------------- | ---------: | -----------: | ---------------: | ------------------: | --------------------: |
| 2,000 x 50, median of 3 |   2,780.47 |     1,710.89 |         1,296.57 |              193.21 |                404.67 |
| 5,000 x 50, 1-run probe |   8,642.23 |     3,924.66 |         2,696.03 |              375.16 |              1,112.24 |

The candidate's worktree walk grows with total source size, while hashing and HEAD-tree traversal remain its dominant phases. Those same phases were responsible for the moderate 25k breadth regression, but at high object count the candidate still avoids the much steeper current-implementation growth. Candidate phase timing is diagnostic-only (`SF_STL_STATUS_PROFILE=true`) and is not expected to sum exactly to wall-clock time because some work is concurrent and framework overhead is uninstrumented.

## RP-01 Results

RP-01 uses a distinct fresh one-day scratch org for each implementation, created through Dev Hub alias `vscodeOrg`. Each leg generated 500 Apex implementation/test pairs, deployed 2,000 source files with `--test-level NoTestRun`, and expected 1,000 ApexClass SourceMembers. The measured public operation is `SourceTracking.updateRemoteTracking()`, which polls for the deployed members and syncs them into remote tracking. Each leg finished with zero outstanding remote changes.

| Implementation                | Scratch org ID       | Public operation ms | Poll detail                                          | Correctness                  |
| ----------------------------- | -------------------- | ------------------: | ---------------------------------------------------- | ---------------------------- |
| Current isomorphic-git        | `00Ddq00000IgyYWEAZ` |              55,010 | 50 poll round trips; 1,000 members returned          | 0 outstanding remote changes |
| PR #888 Effect implementation | `00DRu00000bNdcrMAC` |              55,754 | Instrumentation unavailable in the candidate harness | 0 outstanding remote changes |

**Observation:** RP-01 is a flat ApexClass remote-poll control, not a decomposed metadata representative. The 1.4% candidate difference is within expected deployment-propagation variance and does not demonstrate a remote-poll regression. Retain RP-01 as the baseline control; use RP-02 to evaluate decomposed SourceMember-to-path resolution and local reconciliation. An earlier current leg (`00DRt00000ZsTqVMAV`) was discarded because it recorded only the instrumented `pollForSourceTracking` interval rather than the comparable public poll-and-sync operation; its scratch org was deleted.

## RP-02 Results

RP-02 creates 25 decomposed custom objects with 50 fields each, establishes the remote-tracking baseline, then uses a separate project to deploy description edits to all 50 fields on five objects. The measured public operation is `SourceTracking.updateRemoteTracking()` for the 250 `CustomField` responses. A valid leg must return zero outstanding non-delete remote changes after the operation.

| Implementation                | Scratch org ID       | Expected fields | Public operation ms | Correctness                  |
| ----------------------------- | -------------------- | --------------: | ------------------- | ---------------------------- |
| Current isomorphic-git        | `00DEc00000p57czMAA` |             250 | 15,661              | 0 outstanding remote changes |
| PR #888 Effect implementation | `00DO800000aGVkgMAG` |             250 | 18,591              | 0 outstanding remote changes |

The original concurrent-poll protocol used a deployment gate after the first `sourceMemberPollingEvent`. It produced the valid pair above, but a subsequent current leg left all 250 changes outstanding, so the paired `15,661 ms` and `18,591 ms` values are retained only as exploratory concurrent-poll observations. Do not compare or aggregate them further.

The repeatable protocol deploys the staged changes first, waits `2,000 ms` for SourceMember propagation, then starts and times `updateRemoteTracking()`. The settle period is explicitly outside the timer, so this measures STL reconciliation rather than asynchronous Salesforce deployment latency.

**Propagation caveat:** deployment completion is not a server-side readiness signal for all corresponding `SourceMember` rows. The fixed two-second delay is an empirical stabilization heuristic; RP-02 has no authoritative signal for the instant SourceMember propagation completes. A slow or delayed server can therefore still recreate the earlier missing-member state after the delay. Treat a clean settled run as evidence that the rows were visible for that run, not as proof that the delay guarantees visibility. If production code needs immediate post-deploy consistency, it must retain/retry STL's deployment-aware polling and synchronization rather than rely on a fixed sleep.

| Implementation                | Scratch org ID        | Post-deploy settle ms | Reconciliation ms | Correctness                  |
| ----------------------------- | --------------------- | --------------------: | ----------------: | ---------------------------- |
| Current isomorphic-git        | `00DO500000tTVtvMAG`  |                 2,000 |               483 | 0 outstanding remote changes |
| Current isomorphic-git        | settled current leg 2 |                 2,000 |               427 | 0 outstanding remote changes |
| Current isomorphic-git        | settled current leg 3 |                 2,000 |               248 | 0 outstanding remote changes |
| PR #888 Effect implementation | `00Diz000002YwtFEAS`  |                 2,000 |               527 | 0 outstanding remote changes |
| PR #888 Effect implementation | `00DRL00000ZNm302AD`  |                 2,000 |               397 | 0 outstanding remote changes |
| PR #888 Effect implementation | `00DEm00000YckzTMAR`  |                 2,000 |               397 | 0 outstanding remote changes |

| Implementation                | Valid legs | Median ms | Min ms | Max ms | Median delta |
| ----------------------------- | ---------: | --------: | -----: | -----: | -----------: |
| Current isomorphic-git        |          3 |       427 |    248 |    483 |     baseline |
| PR #888 Effect implementation |          3 |       397 |    397 |    527 |        -7.0% |

All six settled legs synchronized the 250 decomposed child fields. The candidate median is 30 ms faster, but the fresh-org ranges overlap substantially and each measured reconciliation remains below 530 ms. RP-02 therefore provides no reliable evidence of a customer-visible remote-tracking regression or improvement; retain it as a correctness and remote-path guardrail rather than an optimization target. Local status remains the priority because its repeated 30-run fixtures show a stable 33–80% candidate regression.

## RP-03: Remote Reconciliation by Inventory

RP-03 holds the staged remote batch constant at 250 changed `CustomField` members while increasing the decomposed baseline inventory. Before the staged deployment, the harness snapshots each expected member's `RevisionCounter`; after deployment it polls the Tooling API until every expected member has a higher revision. That observed propagation time is reported separately and excluded from the timed public `updateRemoteTracking()` call.

|                  Baseline fields | Updated fields | Current legs ms | Effect legs ms | Current/Effect two-leg median ms | Median delta | Visibility ms, current/effect | Correctness                                                                                |
| -------------------------------: | -------------: | --------------: | -------------: | -------------------------------: | -----------: | ----------------------------- | ------------------------------------------------------------------------------------------ |
|  5,000 (100 objects x 50 fields) |            250 |        444, 218 |       207, 208 |                      331 / 207.5 |       -37.3% | 315, 370 / 297, 297           | All four legs: all 250 revised members visible in first observation; 0 outstanding changes |
| 10,000 (200 objects x 50 fields) |            250 |        292, 288 |       314, 241 |                      290 / 277.5 |        -4.3% | 293, 378 / 330, 348           | All four legs: all 250 revised members visible in first observation; 0 outstanding changes |

Each leg uses a fresh scratch org. The displayed two-leg median is the midpoint of the two ordered measurements. With a fixed 250-field update batch, Effect is faster at both measured baseline inventories, but the 5,000-field current range (`218–444 ms`) and 10,000-field Effect range (`241–314 ms`) are substantial relative to the between-inventory movement. RP-03 therefore supports no reliable inventory-scaling conclusion and does not justify a 20,000-field leg yet; collect a third fresh-org leg at the existing points before extending the curve. The 10,000-field baseline was deployed in two sequential setup batches under a 9,500-component ceiling; batching is excluded from the timed reconciliation operation.

## Future Experiment: SourceMember Propagation by Inventory

Determine whether server-side SourceMember visibility latency varies with metadata inventory independently of the deployment batch. Hold the staged update batch at 250 `CustomField` updates while varying the baseline custom-field inventory: 250, 1,250, 5,000, and 10,000+ fields. For each leg, record the metadata deployment completion timestamp, periodic Tooling API `SourceMember` observations for all expected revision keys, the first poll in which all expected rows are visible, and settled `updateRemoteTracking()` duration. `SourceMember.LastModifiedDate` records server update time but not STL query visibility, so the repeated observations are required to calculate an observed propagation interval.

## Controlled RP Profile

`yarn experiment:remote-profile` creates a fresh scratch org with a moderate 5,000-field decomposed baseline (100 objects x 50 fields). Its default workload is one 250-field remote update batch, producing one CPU and allocation-sampling heap capture rather than repeated statistical samples. The Developer scratch-org custom-object limit prevents deploying the 2,000-object x 50-field LS-08 shape; do not substitute a different object/field ratio solely to preserve field volume. The harness waits until all changed `SourceMember` revisions are visible, then records profiles around `updateRemoteTracking()` only. Deployment, Tooling API visibility polling, fixture generation, and correctness verification are outside the profiled interval.

```bash
STL_DEV_HUB_ALIAS=vscodeOrg \
STL_FIXTURE_PREFIX=StlProfileEffect \
STL_PROFILE_SCRATCH_ALIAS=stl-perf-profile-effect \
STL_PROFILE_DELETE_ORG=true \
yarn experiment:remote-profile
```

Profiles and `summary.md` default to `~/stl-perf/profiles/<fixture-prefix>/`. Override `STL_PROFILE_OUTPUT_DIR` to use another durable location. The defaults can be tuned with `STL_PROFILE_OBJECTS`, `STL_PROFILE_FIELDS_PER_OBJECT`, `STL_PROFILE_BATCH_SIZE`, and `STL_PROFILE_BATCHES`; their product must not exceed the baseline inventory.

## Org-Free Local Status Profile

`yarn experiment:local-profile` creates the LS-08 high-object source shape directly on disk: 2,000 objects x 50 fields (102,000 source files). It creates an on-disk shadow repo under a fixed synthetic org ID, records the generated fixture as the local baseline outside profiling, then captures one CPU profile and allocation-sampling heap profile around the forced zero-change `reReadLocalTrackingCache()` call. It makes no Salesforce connection, SourceMember query, metadata deployment, or remote-tracking call.

```bash
yarn experiment:local-profile
```

The fixture defaults to `~/stl-perf/local-profile-fixture` and is intentionally retained so the generated source can be inspected or reused. Profiles and `summary.md` default to `~/stl-perf/profiles/local-status-2000x50/`. Set `STL_LOCAL_PROFILE_FIXTURE_DIR` and `STL_LOCAL_PROFILE_OUTPUT_DIR` before running to choose new paths. The fixture directory must not already exist, preventing accidental profiling against stale source.

## Detailed Procedure

The first scenario's exact setup, contamination recovery, valid run history, and candidate hypotheses are in [LOCAL_SHADOW_BENCHMARK.md](LOCAL_SHADOW_BENCHMARK.md).

## RP-01 Procedure

`yarn experiment:poll-scratch` creates a one-day scratch org through the Salesforce CLI, generates a flat Apex fixture, starts the poll harness, waits until it captures the initial SourceMember revision floor, and deploys only the generated `classes` directory with `--test-level NoTestRun`. The deployment creates the SourceMember rows that the timed poll consumes; skipping tests prevents unrelated Apex test time from affecting poll-first coordination.

Use the available Dev Hub explicitly:

```bash
STL_DEV_HUB_ALIAS=vscodeOrg \
STL_FIXTURE_COUNT=500 \
STL_FIXTURE_PREFIX=StlPollCurrent \
STL_POLL_SCRATCH_ALIAS=stl-perf-rp01 \
yarn experiment:poll-scratch
```

The default fixture creates 500 implementation/test pairs, so the harness deploys 2,000 source files and polls for 1,000 ApexClass members. Each pair produces four deploy files (`.cls` and `.cls-meta.xml` for both implementation and test), so the Metadata API's 10,000-file deploy limit caps `STL_FIXTURE_COUNT` at 2,500; the runner rejects larger inputs. Keep the scratch org after the first leg, then run the candidate with a distinct prefix, its own fresh floor, and `STL_POLL_REUSE_ORG=true`. Set `STL_POLL_DELETE_ORG=true` only for a disposable one-leg validation run.
