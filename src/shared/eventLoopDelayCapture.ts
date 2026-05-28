/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as Effect from 'effect/Effect';

/**
 * Start a `perf_hooks` event-loop-delay histogram and return a finalizer that
 * stops it and annotates the current span with `elP50Ms`, `elP99Ms`,
 * `elMaxMs`. Same instrument + percentiles as `populateTypesAndNamesPerf.nut.ts`
 * so numbers are comparable across spans.
 *
 * Gated on `STL_OTEL_SPANS=1` so the histogram only runs when explicitly
 * requested. Additionally gated on `process.env.ESBUILD_PLATFORM !== 'web'`
 * so VS Code web bundles (which set `ESBUILD_PLATFORM='web'` via esbuild's
 * `define`) dead-code-eliminate the `node:perf_hooks` require — Web Workers
 * don't have `node:*` APIs.
 * https://code.visualstudio.com/api/extension-guides/web-extensions
 */
const noop: { finalize: () => Effect.Effect<void> } = { finalize: (): Effect.Effect<void> => Effect.void };

export const eventLoopDelayCapture = (): { finalize: () => Effect.Effect<void> } => {
  // The `if` (rather than an early return) keeps the require inside a branch
  // that esbuild can statically eliminate for web bundles when `define` rewrites
  // `process.env.ESBUILD_PLATFORM` to `'web'`. Early returns don't trigger DCE
  // of subsequent statements in esbuild.
  if (process.env.ESBUILD_PLATFORM !== 'web' && process.env.STL_OTEL_SPANS === '1') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { monitorEventLoopDelay } = require('node:perf_hooks') as typeof import('node:perf_hooks');
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    return {
      finalize: () =>
        Effect.gen(function* () {
          // give the sampler one more tick to record any block that finished before its timer fired
          yield* Effect.async<void>((resume) => {
            setImmediate(() => resume(Effect.void));
          });
          histogram.disable();
          yield* Effect.annotateCurrentSpan({
            elP50Ms: histogram.percentile(50) / 1_000_000,
            elP99Ms: histogram.percentile(99) / 1_000_000,
            elMaxMs: histogram.max / 1_000_000,
          });
        }),
    };
  }
  return noop;
};
