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

/**
 * Wall-clock + event-loop-delay measurement helper for perf NUTs.
 * Pattern lifted from populateTypesAndNamesPerf.nut.ts so multiple perf
 * NUTs can share one harness and write a unified JSONL stream the
 * renderer in this directory consumes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { monitorEventLoopDelay, performance, IntervalHistogram } from 'node:perf_hooks';
import { Global } from '@salesforce/core/global';

export type MeasureStats = {
  readonly wallMs: number;
  readonly elP50Ms: number;
  readonly elP99Ms: number;
  readonly elMaxMs: number;
};

export type IsoVsLiteRow = {
  readonly variant: 'iso' | 'lite';
  readonly workload: string; // e.g. 'eda', '200x500'
  readonly op: string; // e.g. 'getInstance', 'getStatus.cold', 'commitChanges'
  readonly rowCount?: number;
  readonly fileCount?: number;
  readonly node: string;
  readonly platform: string;
} & MeasureStats;

const ns = (h: IntervalHistogram, p: number): number => h.percentile(p) / 1_000_000;

/**
 * Time a promise-returning function, capturing wall-clock and an
 * event-loop-delay histogram for the duration of the call.
 */
export const measure = async <T>(fn: () => Promise<T> | T): Promise<{ result: T; stats: MeasureStats }> => {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  // ensure histogram's internal sampler is registered before our work starts
  await new Promise<void>((r) => setImmediate(r));
  const start = performance.now();
  const result = await fn();
  const wallMs = performance.now() - start;
  // give the sampler one more tick to record any block that finished before its timer fired
  await new Promise<void>((r) => setImmediate(r));
  histogram.disable();
  return {
    result,
    stats: {
      wallMs,
      elP50Ms: ns(histogram, 50),
      elP99Ms: ns(histogram, 99),
      elMaxMs: histogram.max / 1_000_000,
    },
  };
};

/**
 * Stable path under ~/.sf so the renderer can find it without extra config.
 * Two-pass runs (iso then lite) append to the same file; the renderer
 * groups by (workload, op) and emits a comparison table.
 */
export const ISO_VS_LITE_JSONL = path.join(Global.SF_DIR, 'source-tracking-perf', 'iso-vs-lite.jsonl');

/** Resolve which backend the run is exercising. */
export const variantFromEnv = (): 'iso' | 'lite' =>
  process.env.SF_SOURCE_TRACKING_USE_LITE_GIT === 'true' ? 'lite' : 'iso';

export const appendIsoVsLiteRow = async (row: Omit<IsoVsLiteRow, 'node' | 'platform'>): Promise<void> => {
  mkdirSync(path.dirname(ISO_VS_LITE_JSONL), { recursive: true });
  const full: IsoVsLiteRow = {
    ...row,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  await fs.appendFile(ISO_VS_LITE_JSONL, `${JSON.stringify(full)}\n`, 'utf8');
};
