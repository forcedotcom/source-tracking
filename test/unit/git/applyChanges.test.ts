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
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { applyChanges } from '../../../src/git/applyChanges';
import { init } from '../../../src/git/init';
import { resolveRef } from '../../../src/git/refs';
import { readLooseObject } from '../../../src/git/objects';
import { readIndex } from '../../../src/git/indexV2';
import { NodeCapabilitiesLayer } from '../../../src/git/capabilities';
import { Author, RefName, RepoPath, SwitchCfg } from '../../../src/git/schemas';

const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCapabilitiesLayer);
const FIXED_TS = Date.parse('2026-01-01T00:00:00Z');

const ALICE: Author = { name: 'sfdx source tracking', email: 'source-tracking@noreply.salesforce.com' };

const cfg = (dir: string, gitdir: string): SwitchCfg => ({
  dir,
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('a')],
  fdPermits: 8,
});

describe('git/applyChanges (phase 9)', () => {
  it('empty streams: no commit, returns existing HEAD oid', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-empty-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(dir, { recursive: true });
      await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));
      const before = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('refs/heads/main')), Layered)
      );
      const result = await Effect.runPromise(
        Effect.provide(
          applyChanges({
            cfg: { dir, gitdir },
            adds: Stream.empty,
            removes: Stream.empty,
            message: 'noop',
            author: ALICE,
          }),
          Layered
        )
      );
      expect(result).to.equal(before);
      const after = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('refs/heads/main')), Layered)
      );
      expect(after).to.equal(before); // no new commit
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('add a single file: HEAD advances, index has one entry, blob is readable', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-add-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a', 'b.txt'), 'hello applyChanges\n');

      await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));

      const before = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('refs/heads/main')), Layered)
      );

      const newCommit = await Effect.runPromise(
        Effect.provide(
          applyChanges({
            cfg: { dir, gitdir },
            adds: Stream.fromIterable([Schema.decodeUnknownSync(RepoPath)('a/b.txt')]),
            removes: Stream.empty,
            message: 'add a/b.txt',
            author: ALICE,
          }),
          Layered
        )
      );
      expect(newCommit).to.not.equal(before);

      // refs/heads/main updated
      const after = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('refs/heads/main')), Layered)
      );
      expect(after).to.equal(newCommit);

      // index has one entry pointing at the right path/mode
      const idx = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      expect(idx.entries).to.have.lengthOf(1);
      expect(idx.entries[0]?.path).to.equal('a/b.txt');
      expect(idx.entries[0]?.mode).to.equal(0o100644);

      // commit object decodes and references a tree
      const commit = await Effect.runPromise(Effect.provide(readLooseObject(gitdir, newCommit), Layered));
      expect(commit.type).to.equal('commit');
      const decoded = new TextDecoder().decode(commit.content);
      expect(decoded).to.match(/^tree [0-9a-f]{40}\n/);
      expect(decoded).to.include(`parent ${before}`);
      expect(decoded).to.include('add a/b.txt');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('add then remove: index ends empty, tree is the canonical empty-tree', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-rm-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a', 'b.txt'), 'short-lived\n');

      await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));

      // First: add
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
      // Then: remove
      const final = await Effect.runPromise(
        Effect.provide(
          applyChanges({
            cfg: { dir, gitdir },
            adds: Stream.empty,
            removes: Stream.fromIterable([Schema.decodeUnknownSync(RepoPath)('a/b.txt')]),
            message: 'remove',
            author: ALICE,
          }),
          Layered
        )
      );
      const idx = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      expect(idx.entries).to.have.lengthOf(0);

      // commit references the canonical empty tree
      const commit = await Effect.runPromise(Effect.provide(readLooseObject(gitdir, final), Layered));
      const decoded = new TextDecoder().decode(commit.content);
      expect(decoded).to.match(/^tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
