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

- `Stream.runFoldEffect` / `Effect.reduce` for the resolve-then-claim fold.
- Persistent `HashMap` / `HashSet` with structural values for dedup.
- `Effect.fn(name)` for span instrumentation on the outer function. Per-component
  `getAllFiles` spans were removed after measurement showed their overhead.

The library does not construct or accept an OTel SDK layer. Its private
ManagedRuntimes use Effect's empty layer, so library spans are not exported.
Performance tests that need span output provide their own `NodeSdk.layer` from
`test/perf-utils`. Consumer-provided tracing is deferred to a separate design.

### Follow-up: synchronous `populateTypesAndNames` fold

`populateTypesAndNames` uses native `Map`/`Set` in its measured resolve-then-claim
fold. That fold is synchronous and contains no effectful work to schedule; the
persistent collection version was slower. This is a targeted hot-path exception,
not a general replacement for Effect Streams or persistent collections in
effectful folds. It trades cooperative yielding during that fold for lower
measured wall time.

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

Conclusion on throttle: at this scale Effect's default cooperative yielding
(every ~2048 fiber ops) is sufficient. Explicit `Effect.yieldNow()`
sprinkling has no measurable wall-time cost or benefit. Default
`yieldEvery: 0` (no extra yields). The lever stays exposed as `@internal` for
adversarial workloads.

Vanilla `Map`/`Set` vs `HashMap`/`HashSet` + `Data.struct` (resolve-then-claim,
no spans, three runs each):

| Variant                     | Wall p50 (ms) | EL p99                                         |
| --------------------------- | ------------- | ---------------------------------------------- |
| Vanilla mutable collections | 245           | sometimes wall-blocking (245ms), sometimes 0ms |
| `HashMap` + `Data.struct`   | 289           | reliably 0ms                                   |

`HashMap`+`Data.struct` is ~15 % slower wall-clock but yields more often
(persistent-structure cloning produces more fiber ops, triggering Effect's
cooperative yielding more reliably). The wall-clock difference (~44ms at 35k)
is dwarfed by the legacy reduction (~1500ms saved). That was the initial
decision; the targeted synchronous-fold follow-up above records the later
switch to native collections for this function.

EDA fixture (6,462 input filenames, real Salesforce metadata): legacy 398ms
→ resolve-then-claim 245ms (1.6×).

Bottom line: resolve-then-claim eliminates a 1.7-second sync block per
status refresh on bundle-heavy projects, with no remaining event-loop block
detectable at 1 ms resolution.
