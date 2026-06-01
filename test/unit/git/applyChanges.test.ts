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
import * as HashSet from 'effect/HashSet';
import { applyChanges } from '../../../src/git/applyChanges';
import { init } from '../../../src/git/init';
import { resolveRef } from '../../../src/git/refs';
import { readLooseObject } from '../../../src/git/objects';
import { readIndex, type IndexEntry } from '../../../src/git/indexV2';
import { writeIndexV2 } from '../../../src/git/writers';
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

  it('stageAdd records real (size, mtime) so stat-trust can hit on the next status', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-stat-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      const filePath = path.join(dir, 'a', 'b.txt');
      const contents = 'stat-trust round-trip\n';
      await fs.writeFile(filePath, contents);
      const workdirStat = await fs.stat(filePath);

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

      const idx = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      expect(idx.entries).to.have.lengthOf(1);
      const entry = idx.entries[0];
      // size matches bytes written
      expect(entry?.stat.size).to.equal(Buffer.byteLength(contents));
      // mtime matches the workdir mtime to ms precision — this is what
      // statTrustOid compares against. A zero here regresses the fast path.
      const recordedMs = (entry?.stat.mtimeSec ?? 0) * 1000 + Math.floor((entry?.stat.mtimeNsec ?? 0) / 1_000_000);
      expect(recordedMs).to.equal(workdirStat.mtime.getTime());
      expect(entry?.stat.mtimeSec).to.be.greaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('extensions: drops TREE/REUC/UNTR cache extensions, carries stable extensions verbatim', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-ext-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a', 'first.txt'), 'one\n');
      await fs.writeFile(path.join(dir, 'a', 'second.txt'), 'two\n');

      await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));

      // First commit: get a single entry into the index.
      await Effect.runPromise(
        Effect.provide(
          applyChanges({
            cfg: { dir, gitdir },
            adds: Stream.fromIterable([Schema.decodeUnknownSync(RepoPath)('a/first.txt')]),
            removes: Stream.empty,
            message: 'first',
            author: ALICE,
          }),
          Layered
        )
      );

      // Hand-rewrite .git/index to embed two extensions: a cache-class
      // 'TREE' (must drop) and a synthetic stable 'link' (must carry).
      const beforeIdx = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      const entriesSet = HashSet.fromIterable<IndexEntry>(beforeIdx.entries);
      const fakeTreePayload = new Uint8Array([0x00]); // any non-empty bytes; we never re-parse it
      const fakeLinkPayload = new TextEncoder().encode('synthetic-stable-payload');
      const reseededBytes = await Effect.runPromise(
        Effect.provide(
          writeIndexV2(entriesSet, [
            { signature: 'TREE', payload: fakeTreePayload },
            { signature: 'link', payload: fakeLinkPayload },
          ]),
          Layered
        )
      );
      await fs.writeFile(path.join(gitdir, 'index'), reseededBytes);

      // Sanity: confirm both extensions are present before applyChanges.
      const seeded = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      expect(seeded.extensions.map((e) => e.signature)).to.include.members(['TREE', 'link']);

      // Second commit: should drop TREE, preserve 'link' verbatim.
      await Effect.runPromise(
        Effect.provide(
          applyChanges({
            cfg: { dir, gitdir },
            adds: Stream.fromIterable([Schema.decodeUnknownSync(RepoPath)('a/second.txt')]),
            removes: Stream.empty,
            message: 'second',
            author: ALICE,
          }),
          Layered
        )
      );

      const afterIdx = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      const sigs = afterIdx.extensions.map((e) => e.signature);
      expect(sigs).to.not.include('TREE');
      expect(sigs).to.include('link');
      const linkExt = afterIdx.extensions.find((e) => e.signature === 'link');
      expect(linkExt, 'link extension').to.not.equal(undefined);
      expect(Array.from(linkExt?.payload ?? [])).to.deep.equal(Array.from(fakeLinkPayload));
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
