# `populateTypesAndNames` perf results

Run: `yarn mocha test/nuts/local/populateTypesAndNamesPerf.nut.ts --slow 4500 --timeout 600000`
Date: 2026-05-27
Branch: `sm/perf-improvements`
Host: Darwin 25.5.0 (`Darwin 25.5.0`)

## Historical run

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

- `effect`: resolve-then-claim fold, called by local status and conflict detection through [src/shared/runtime.ts](../src/shared/runtime.ts).
- `legacy` rows are historical measurements of the pre-Effect implementation. The comparison implementation and baseline runs have been removed; the current perf NUT measures only the Effect implementation.
- Historical result counts matched; counts alone do not prove behavioral equivalence.
- Historical sampler could miss synchronous blocks entirely. Zero delay is not evidence of yielding. Current NUT validates the sampler, asserts full result counts and latency budgets, and yields between 100-filename batches.
- Raw JSONL: `/var/folders/r4/pj95jr_j41707b_yfx_pfwf80000gn/T/stl-perf-stats.jsonl`.
- OTel spans (effect runs only): `~/.sf/source-tracking-spans/<label>-<timestamp>.jsonl`.
