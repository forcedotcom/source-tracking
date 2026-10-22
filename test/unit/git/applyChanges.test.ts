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
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodePath from '@effect/platform-node/NodePath';
import * as HashSet from 'effect/HashSet';
import { applyChanges } from '../../../src/git/applyChanges.js';
import { init } from '../../../src/git/init.js';
import { resolveRef } from '../../../src/git/refs.js';
import { readLooseObject } from '../../../src/git/objects.js';
import { readIndex, type IndexEntry } from '../../../src/git/indexV2.js';
import { streamHeadTree } from '../../../src/git/trees.js';
import { writeIndexV2 } from '../../../src/git/writers.js';
import { Author, RefName, RepoPath, RepoConfig } from '../../../src/git/schemas.js';

const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer);
const FIXED_TS = Date.parse('2026-01-01T00:00:00Z');

const ALICE: Author = { name: 'sfdx source tracking', email: 'source-tracking@noreply.salesforce.com' };

const cfg = (dir: string, gitdir: string): RepoConfig => ({
  dir,
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('a')],
  fdPermits: 8,
});

describe('git/applyChanges (phase 9)', () => {
  it('keeps HEAD readable after deleting the last file from an existing repository', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-existing-empty-'));
    try {
      const fixture = fileURLToPath(new URL('../../git/fixtures/single-file/', import.meta.url));
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(tmp, 'git');
      await fs.cp(path.join(fixture, 'work'), dir, { recursive: true });
      await fs.cp(path.join(fixture, 'dot-git'), gitdir, { recursive: true });
      await fs.unlink(path.join(dir, 'hello.txt'));
      await Effect.runPromise(
        applyChanges({
          cfg: { dir, gitdir },
          adds: Stream.empty,
          removes: Stream.make(Schema.decodeUnknownSync(RepoPath)('hello.txt')),
          message: 'remove last file',
          author: ALICE,
        }).pipe(Effect.provide(Layered))
      );
      const files = await Effect.runPromise(streamHeadTree(gitdir).pipe(Stream.runCollect, Effect.provide(Layered)));
      expect(files).to.deep.equal([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

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
      expect(idx.entries[0]?.mode).to.equal(0o10_0644);
      expect(
        await fs.stat(path.join(gitdir, 'index.lock')).then(
          () => true,
          () => false
        )
      ).to.equal(false);

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

  it('stores symlinks as link-target blobs with symlink mode', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-symlink-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a', 'target.txt'), 'target contents');
      await fs.symlink('target.txt', path.join(dir, 'a', 'link.txt'));
      await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));

      await Effect.runPromise(
        Effect.provide(
          applyChanges({
            cfg: { dir, gitdir },
            adds: Stream.make(Schema.decodeUnknownSync(RepoPath)('a/link.txt')),
            removes: Stream.empty,
            message: 'add symlink',
            author: ALICE,
          }),
          Layered
        )
      );

      const index = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      expect(index.entries).to.have.lengthOf(1);
      const entry = index.entries[0];
      if (!entry) throw new Error('Expected a symlink index entry');
      expect(entry.mode).to.equal(0o12_0000);
      const blob = await Effect.runPromise(Effect.provide(readLooseObject(gitdir, entry.oid), Layered));
      expect(new TextDecoder().decode(blob.content)).to.equal('target.txt');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('concurrent commits preserve the parent chain', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-concurrent-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a', 'first.txt'), 'first\n');
      await fs.writeFile(path.join(dir, 'a', 'second.txt'), 'second\n');
      await Effect.runPromise(Effect.provide(init({ cfg: cfg(dir, gitdir), timestampMs: FIXED_TS }), Layered));
      const initialHead = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('refs/heads/main')), Layered)
      );

      const addFile = (file: string) =>
        Effect.runPromise(
          Effect.provide(
            applyChanges({
              cfg: { dir, gitdir },
              adds: Stream.make(Schema.decodeUnknownSync(RepoPath)(file)),
              removes: Stream.empty,
              message: `add ${file}`,
              author: ALICE,
            }),
            Layered
          )
        );
      const [firstCommit, secondCommit] = await Promise.all([addFile('a/first.txt'), addFile('a/second.txt')]);
      const finalHead = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('refs/heads/main')), Layered)
      );
      const finalCommit = await Effect.runPromise(Effect.provide(readLooseObject(gitdir, finalHead), Layered));
      const parentLine = new TextDecoder()
        .decode(finalCommit.content)
        .split('\n')
        .find((line) => line.startsWith('parent '));

      expect(finalCommit.type).to.equal('commit');
      expect([firstCommit, secondCommit]).to.include(finalHead);
      expect(parentLine).to.not.be.undefined;
      expect([firstCommit, secondCommit].filter((oid) => oid !== finalHead)).to.include(
        parentLine?.slice('parent '.length)
      );
      expect(parentLine?.slice('parent '.length)).not.to.equal(initialHead);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('stageAdd records workdir stat fields in the index entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-apply-stat-'));
    try {
      const dir = path.join(tmp, 'work');
      const gitdir = path.join(dir, '.git');
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      const filePath = path.join(dir, 'a', 'b.txt');
      const contents = 'index stat round-trip\n';
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
      // mtime matches the workdir mtime to ms precision.
      const recordedMs = (entry?.stat.mtimeSec ?? 0) * 1000 + Math.floor((entry?.stat.mtimeNsec ?? 0) / 1_000_000);
      expect(Math.abs(recordedMs - workdirStat.mtimeMs)).to.be.at.most(1);
      expect(entry?.stat.mtimeSec).to.be.greaterThan(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('extensions: drops stale cache extensions, carries stable extensions verbatim', async () => {
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

      // Hand-rewrite .git/index to embed cache-class extensions and a
      // synthetic stable 'link' extension.
      const beforeIdx = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      const entriesSet = HashSet.fromIterable<IndexEntry>(beforeIdx.entries);
      const fakeTreePayload = new Uint8Array([0x00]); // any non-empty bytes; we never re-parse it
      const fakeLinkPayload = new TextEncoder().encode('synthetic-stable-payload');
      const reseededBytes = await Effect.runPromise(
        Effect.provide(
          writeIndexV2(entriesSet, [
            { signature: 'TREE', payload: fakeTreePayload },
            { signature: 'UNTR', payload: fakeTreePayload },
            { signature: 'link', payload: fakeLinkPayload },
          ]),
          Layered
        )
      );
      await fs.writeFile(path.join(gitdir, 'index'), reseededBytes);

      // Sanity: confirm both extensions are present before applyChanges.
      const seeded = await Effect.runPromise(Effect.provide(readIndex(gitdir), Layered));
      expect(seeded.extensions.map((e) => e.signature)).to.include.members(['TREE', 'UNTR', 'link']);

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
      expect(sigs).to.not.include('UNTR');
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
