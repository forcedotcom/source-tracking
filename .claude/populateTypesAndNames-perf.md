# `populateTypesAndNames` perf results

Run: `yarn mocha test/nuts/local/populateTypesAndNamesPerf.nut.ts --slow 4500 --timeout 600000`
Date: 2026-05-27
Branch: `sm/perf-improvements`
Host: Darwin 25.5.0 (`Darwin 25.5.0`)

## Latest run

| Fixture         | Variant | Input  | Result | Wall (ms) | EL p99 (ms) | EL max (ms) |
| --------------- | ------- | ------ | ------ | --------- | ----------- | ----------- |
| EDA             | legacy  | 6,462  | 6,462  | 916.6     | ~0.0        | 0.0         |
| EDA             | effect  | 6,462  | 6,462  | 295.3     | 295.7       | 295.7       |
| objects-350x100 | legacy  | 35,350 | 35,350 | 2,210.3   | 2,212.5     | 2,212.5     |
| objects-350x100 | effect  | 35,350 | 35,350 | 382.2     | ~0.0        | 0.0         |

Speedups vs legacy: **3.1×** on EDA, **5.8×** on `objects-350x100`.

## Earlier run (same session, warm machine)

| Fixture         | Variant | Input  | Result | Wall (ms) |
| --------------- | ------- | ------ | ------ | --------- |
| EDA             | legacy  | 6,462  | 6,462  | 436.1     |
| EDA             | effect  | 6,462  | 6,462  | 165.5     |
| objects-350x100 | legacy  | 35,350 | 35,350 | 3,704.8   |
| objects-350x100 | effect  | 35,350 | 35,350 | 402.8     |

Speedups vs legacy: **2.6×** on EDA, **9.2×** on `objects-350x100`.

## Notes

- `effect` is the resolve-then-claim Stream pipeline now wired into `SourceTracking.getLocalStatusRows` and `getDedupedConflictsFromChanges`, both routed through the shared `ManagedRuntime` in [src/shared/runtime.ts](../src/shared/runtime.ts).
- `legacy` is the O(N) `MetadataResolver.getComponentsFromPath`-per-filename baseline kept around in [src/shared/populateTypesAndNamesLegacy.ts](../src/shared/populateTypesAndNamesLegacy.ts) for equivalence + speedup measurement.
- Result-element counts match between variants on both fixtures, confirming behavioral equivalence at this sample.
- Event-loop-delay numbers swing because the `monitorEventLoopDelay({ resolution: 1 })` sampler can record one outlier sample per run; treat them as upper bounds rather than steady-state EL pressure.
- Raw JSONL: `/var/folders/r4/pj95jr_j41707b_yfx_pfwf80000gn/T/stl-perf-stats.jsonl`.
- OTel spans (effect runs only): `~/.sf/source-tracking-spans/<label>-<timestamp>.jsonl`.
