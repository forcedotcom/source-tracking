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
import { performance } from 'node:perf_hooks';
import { expect } from 'chai';
import { measureSharedEventLoop } from '../perf/sharedEventLoop';

describe('shared event-loop measurement', () => {
  it('detects a deliberate synchronous block as lost heartbeat progress', async () => {
    const { stats } = await measureSharedEventLoop(async () => {
      const start = performance.now();
      while (performance.now() - start < 100) {
        // Deliberately block the shared event loop.
      }
    });

    expect(stats.heartbeatCount).to.be.greaterThan(0);
    expect(stats.operationHeartbeatCount).to.equal(0);
    expect(stats.longestHeartbeatGapMs).to.be.at.least(80);
    expect(stats.eventLoopSamples).to.be.greaterThan(0);
    expect(stats.eventLoopMaxMs).to.be.at.least(80);
  });
});
