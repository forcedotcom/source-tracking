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
// Phase 10 oracle: round-trip lite ↔ iso-git on a real .git/ shadow.
// Deleted in phase 14 alongside the iso-git removal.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import gracefulFs from 'graceful-fs';
import gitClient from 'isomorphic-git';
import { applyChanges } from '../../../src/git/applyChanges';
import { init } from '../../../src/git/init';
import { resolveRef } from '../../../src/git/refs';
import { readIndex } from '../../../src/git/indexV2';
import { hashBlob } from '../../../src/git/objects';
import { NodeCapabilitiesLayer } from '../../../src/git/capabilities';
import { Author, RefName, RepoPath, SwitchCfg } from '../../../src/git/schemas';

const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCapabilitiesLayer);
const FIXED_TS = Date.parse('2026-01-01T00:00:00Z');

const ALICE: Author = { name: 'sfdx source tracking', email: 'source-tracking@noreply.salesforce.com' };

const cfgOf = (dir: string, gitdir: string): SwitchCfg => ({
  dir,
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('b.txt')],
  fdPermits: 8,
});

describe('git/migration.oracle (phase 10)', () => {
  it('iso-git init → lite reads HEAD + tree', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-oracle-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.sf', 'shadow', '.git');
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(gitdir, { recursive: true });
      // 1. iso-git init
      await gitClient.init({ fs: gracefulFs, dir, gitdir, defaultBranch: 'main' });
      await fs.writeFile(path.join(dir, 'a.txt'), 'oracle\n');
      await gitClient.add({ fs: gracefulFs, dir, gitdir, filepath: 'a.txt' });
      const isoCommit = await gitClient.commit({
        fs: gracefulFs,
        dir,
        gitdir,
        message: 'iso',
        author: { name: ALICE.name, email: ALICE.email, timestamp: FIXED_TS / 1000, timezoneOffset: 0 },
      });

      // 2. Lite reads HEAD
      const liteHead = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('HEAD')), Layered)
      );
      expect(liteHead).to.equal(isoCommit);

      // Lite reads index
      const idx = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      expect(idx.entries).to.have.lengthOf(1);
      expect(idx.entries[0]?.path).to.equal('a.txt');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('lite init + applyChanges → iso-git reads back the same HEAD oid', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-oracle-2-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.sf', 'shadow', '.git');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'b.txt'), 'lite-write\n');

      await Effect.runPromise(Effect.provide(init({ cfg: cfgOf(dir, gitdir), timestampMs: FIXED_TS }), Layered));
      const liteCommit = await Effect.runPromise(
        Effect.provide(
          applyChanges({
            cfg: { dir, gitdir },
            adds: Stream.fromIterable([Schema.decodeUnknownSync(RepoPath)('b.txt')]),
            removes: Stream.empty,
            message: 'from-lite',
            author: ALICE,
          }),
          Layered
        )
      );

      // iso-git reads HEAD
      const isoHead = await gitClient.resolveRef({ fs: gracefulFs, dir, gitdir, ref: 'HEAD' });
      expect(isoHead).to.equal(liteCommit);

      // iso-git reads the blob
      const isoBlob = await gitClient.readBlob({ fs: gracefulFs, dir, gitdir, oid: liteCommit, filepath: 'b.txt' });
      expect(new TextDecoder().decode(isoBlob.blob)).to.equal('lite-write\n');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("hashBlob matches iso-git's hashBlob for the same content", async () => {
    const content = new TextEncoder().encode('share-the-hash\n');
    const liteOid = await Effect.runPromise(Effect.provide(hashBlob(content), Layered));
    const isoOid = (await gitClient.hashBlob({ object: content })).oid;
    expect(liteOid).to.equal(isoOid);
  });
});
