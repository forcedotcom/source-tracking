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
import * as Stream from 'effect/Stream';
import * as Exit from 'effect/Exit';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { applyChanges } from '../../../src/git/applyChanges';
import { init } from '../../../src/git/init';
import { isEnabled, runIntegrityCheck } from '../../../src/git/integrityCheck';
import { NodeCapabilitiesLayer } from '../../../src/git/capabilities';
import { Author, RepoPath, SwitchCfg } from '../../../src/git/schemas';

const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCapabilitiesLayer);
const FIXED_TS = Date.parse('2026-01-01T00:00:00Z');
const ALICE: Author = { name: 'sfdx source tracking', email: 'source-tracking@noreply.salesforce.com' };

const cfg = (dir: string, gitdir: string): SwitchCfg => ({
  dir,
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('a')],
  fdPermits: 8,
});

describe('git/integrityCheck (phase 13)', () => {
  describe('isEnabled', () => {
    it('default off', () => {
      delete process.env.SF_SOURCE_TRACKING_INTEGRITY_CHECK;
      expect(isEnabled()).to.equal(false);
    });

    it('on for "true"', () => {
      process.env.SF_SOURCE_TRACKING_INTEGRITY_CHECK = 'true';
      try {
        expect(isEnabled()).to.equal(true);
      } finally {
        delete process.env.SF_SOURCE_TRACKING_INTEGRITY_CHECK;
      }
    });
  });

  describe('runIntegrityCheck', () => {
    it('passes on a freshly-init+applyChanges shadow', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-integ-'));
      try {
        const dir = path.join(tmp, 'work');
        const gitdir = path.join(dir, '.git');
        await fs.mkdir(path.join(dir, 'a'), { recursive: true });
        await fs.writeFile(path.join(dir, 'a', 'b.txt'), 'hello\n');
        await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));
        await Effect.runPromise(
          Effect.provide(
            applyChanges({
              cfg: { dir, gitdir },
              adds: Stream.fromIterable([Schema.decodeUnknownSync(RepoPath)('a/b.txt')]),
              removes: Stream.empty,
              message: 'add',
              author: ALICE,
            }),
            Layered
          )
        );
        const exit = await Effect.runPromiseExit(Effect.provide(runIntegrityCheck(gitdir), Layered));
        expect(Exit.isSuccess(exit)).to.equal(true);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('fails closed when refs/heads/main is absent', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-integ-fail-'));
      try {
        const dir = path.join(tmp, 'work');
        const gitdir = path.join(dir, '.git');
        await fs.mkdir(dir, { recursive: true });
        await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));
        // Plant corruption: delete refs/heads/main.
        await fs.unlink(path.join(gitdir, 'refs', 'heads', 'main'));
        const exit = await Effect.runPromiseExit(Effect.provide(runIntegrityCheck(gitdir), Layered));
        expect(Exit.isFailure(exit)).to.equal(true);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
