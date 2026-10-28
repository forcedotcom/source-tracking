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
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export type SharedEventLoopStats = {
  readonly wallMs: number;
  readonly heartbeatCount: number;
  readonly operationHeartbeatCount: number;
  readonly longestHeartbeatGapMs: number;
  readonly eventLoopP99Ms: number;
  readonly eventLoopMaxMs: number;
  readonly eventLoopSamples: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run work alongside a same-thread timer heartbeat, approximating unrelated
 * extension-host callbacks that must make progress while STL is active.
 */
export const measureSharedEventLoop = async <A>(
  operation: () => Promise<A>
): Promise<{ result: A; stats: SharedEventLoopStats }> => {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  let heartbeatCount = 0;
  let longestHeartbeatGapMs = 0;
  let lastHeartbeat = performance.now();

  const beat = () => {
    const now = performance.now();
    longestHeartbeatGapMs = Math.max(longestHeartbeatGapMs, now - lastHeartbeat);
    lastHeartbeat = now;
    heartbeatCount += 1;
  };

  const interval: NodeJS.Timeout = setInterval(beat, 1);

  histogram.enable();
  try {
    // Arm the histogram and establish a pre-operation heartbeat.
    await sleep(20);
    heartbeatCount = 0;
    longestHeartbeatGapMs = 0;
    lastHeartbeat = performance.now();
    histogram.reset();
    // A timer turn after reset is required before synchronous work can be
    // observed by both the histogram and the competing heartbeat.
    await sleep(10);

    const start = performance.now();
    const heartbeatCountAtStart = heartbeatCount;
    const result = await operation();
    const wallMs = performance.now() - start;
    const operationHeartbeatCount = heartbeatCount - heartbeatCountAtStart;

    // Let both mechanisms observe the final gap before recording their values.
    await sleep(20);
    return {
      result,
      stats: {
        wallMs,
        heartbeatCount,
        operationHeartbeatCount,
        longestHeartbeatGapMs,
        eventLoopP99Ms: histogram.percentile(99) / 1_000_000,
        eventLoopMaxMs: histogram.max / 1_000_000,
        eventLoopSamples: histogram.count,
      },
    };
  } finally {
    clearInterval(interval);
    histogram.disable();
  }
};
