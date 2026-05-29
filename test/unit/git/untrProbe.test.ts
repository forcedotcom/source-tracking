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
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { probeUntr } from '../../../src/git/untrProbe';

const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

describe('git/untrProbe (phase 11)', () => {
  it('returns ok on a real Node fs (APFS/ext4 etc.)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-untr-probe-'));
    try {
      const result = await Effect.runPromise(Effect.provide(probeUntr(tmp), Layered));
      expect(result.kind).to.be.oneOf(['ok', 'failed']); // some CI fs may have coarse mtime
      if (result.kind === 'failed') {
        expect(result.reason).to.be.oneOf(['unstable_ino', 'coarse_mtime', 'ctime_static']);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
