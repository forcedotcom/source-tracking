# 2. Adopt Effect for performance-critical internals; library does not configure the OTel SDK

Date: 2026-04-30

## Status

Accepted

## Context

Object/bundle-heavy projects (35k+ files) measure 333–449 ms event-loop lag per
status refresh ([perf-tracking-bug findings.md][findings]). The dominant
synchronous bucket inside `tracking.getStatus()` is
[`populateTypesAndNames`](../../src/shared/populateTypesAndNames.ts), which
calls SDR's `getComponentsFromPath` once per filename — including for many files
that resolve to one bundle component — and then walks each component's content
synchronously.

Two problems:

1. **Algorithmic** — redundant resolves and walks per filename in the same
   bundle.
2. **Runtime** — synchronous loops with no scheduler hooks; cannot yield to
   Node's event loop, blocks paste/typing latency in the consumer (VS Code).

We considered:

- Vanilla async + `setImmediate` yielding inside the loop. Works, but lacks
  composable streaming, no built-in tracing, no structured error model.
- `p-limit` for batching. Same issues.
- `worker_threads` to push the work off-thread. Significant complexity for a
  CPU-bound but already-fast (in aggregate) workload; serialization cost
  dominates for ~milliseconds of work per item.
- Effect v4 (`effect` core). Built-in fiber scheduler with explicit yield
  primitives, `Stream`/`Effect.reduce` for functional state-threading, persistent
  `HashMap`/`HashSet` with structural values, and named spans through `Effect.fn`.

## Decision

Adopt Effect for performance-critical internals, starting with
`populateTypesAndNames`. Use:

- Native `Map` / `Set` for resolve-then-claim and input-identity deduplication.
- `Effect.reduce` over batches of 100 filenames, yielding between batches.
- `Effect.fn(name)` for span instrumentation on the outer function. Per-component
  `getAllFiles` spans were removed after measurement showed their overhead.

The library does not construct or accept an OTel SDK layer. Its private
ManagedRuntimes use Effect's empty layer, so library spans are not exported.
Performance tests that need span output provide their own `NodeSdk.layer` from
`test/perf-utils`. Consumer-provided tracing is deferred to a separate design.

### Follow-up: native collections with bounded yielding

`populateTypesAndNames` retains native `Map`/`Set`; the persistent collection
version was slower. A single synchronous fold still blocked the event loop for
hundreds of milliseconds. The fold now resolves batches of 100 filenames and
uses `Effect.yieldNow` between batches. This trades some wall time for event-loop
responsiveness without restoring redundant component resolution.

ESLint rules for Effect-using files (mirroring
[salesforcedx-vscode/eslint.config.mjs][vscode-eslint] lines 583-645):
`@effect/no-import-from-barrel-package`, `functional/no-loop-statements`,
`functional/no-let`, `functional/no-throw-statements`,
`functional/no-try-statements`, `functional/prefer-property-signatures`, and a
vendored `local-rules/no-explicit-effect-return-type` (originally from the same
vscode repo's `eslint-local-rules`). The flat-config override applies to the
Effect operation modules listed in `eslint.config.mjs`; Promise/runtime adapters
remain outside that scope because they contain boundary-specific exception
handling.

## Consequences

- New runtime dependency: `effect`. `@effect/opentelemetry` and OpenTelemetry SDK
  packages are dev dependencies used by the performance NUTs only.
- The package has no internal SDK, exporter, or `STL_OTEL_SPANS` capture path.
  Effect span calls remain available for a future consumer-integration design.
- Future contributors writing inside the `overrides` glob must follow the
  Effect conventions; the lint rules enforce this.
- Performance numbers (before/after baseline, plus throttle-lever sweep) will
  be appended to this ADR as the work lands.

[findings]: https://github.com/dummy/repros/perf-tracking-bug/findings.md
[vscode-eslint]: https://github.com/forcedotcom/salesforcedx-vscode/blob/develop/eslint.config.mjs

## Measured numbers

The tables below are historical. Their event-loop sampler could record zero
samples during a synchronous block; reported zero-delay values do not establish
that the event loop stayed responsive.

Source: `test/nuts/local/populateTypesAndNamesPerf.nut.ts` on Apple M-series
(node v24.14.1, macOS 25.4.0), 350 CustomObjects × 100 CustomFields = 35,350
file fixture, generated via `mkdtempSync`. Wall time = `performance.now`
delta around the call. `el-p99` and `el-max` from `perf_hooks.monitorEventLoopDelay`
sampled at 1ms resolution. Run-to-run noise ~5–10 %.

| Variant                                      | Wall (ms) | EL p99 (ms) | EL max (ms) | Notes                                                                                                             |
| -------------------------------------------- | --------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| **Legacy** (sync, O(N) resolves)             | 1753      | 1754        | 1754        | event loop fully blocked for entire wall                                                                          |
| Effect literal translation (no algo chg)     | 3916      | 0           | 0           | per-component spans (35,350 of them) dominate cost; el-p99 stays at zero because Effect yields between iterations |
| **Resolve-then-claim** (HashMap+Data.struct) | 304       | 0           | 0           | algorithm change: K resolves + K walkContent calls instead of N                                                   |
| + drop per-component span                    | 264       | 0           | 0           | only the outer `populateTypesAndNames` span remains                                                               |

Throttle-lever sweep (resolve-then-claim, no per-component span):

| `yieldEvery` | Wall (ms) | EL p99 (ms) |
| ------------ | --------- | ----------- |
| 0 (default)  | 264       | 0           |
| 100          | 262       | 0           |
| 500          | 257       | 0           |
| 1000         | 281       | 0           |
| 5000         | 261       | 0           |

That sweep measured an earlier Effect-heavy implementation, not the later
synchronous native-collection fold. The current implementation uses fixed
100-filename batches; there is no configurable `yieldEvery` option.

Vanilla `Map`/`Set` vs `HashMap`/`HashSet` + `Data.struct` (resolve-then-claim,
no spans, three runs each):

| Variant                     | Wall p50 (ms) | EL p99                                         |
| --------------------------- | ------------- | ---------------------------------------------- |
| Vanilla mutable collections | 245           | sometimes wall-blocking (245ms), sometimes 0ms |
| `HashMap` + `Data.struct`   | 289           | reported 0ms; sampler unvalidated              |

`HashMap`+`Data.struct` measured ~15 % slower wall-clock. That was the initial
decision; the follow-up above records the switch to native collections and
explicit batch yields. Historical zero-delay measurements cannot compare
responsiveness between these implementations.

EDA fixture (6,462 input filenames, real Salesforce metadata): legacy 398ms
→ resolve-then-claim 245ms (1.6×).

Current performance validation warms and drains the histogram using timer
ticks, verifies nonzero sample counts, and checks that a deliberate 100 ms block
is detected. The pinned EDA fixture and generated 35,350-file fixture assert
complete result counts, wall time below 10 seconds, and maximum event-loop delay
below 100 ms (Windows: 30 seconds and 250 ms). These are fixture-specific CI
budgets, not guarantees for arbitrary projects.
