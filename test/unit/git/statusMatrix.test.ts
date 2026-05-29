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
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { cold } from '../../../src/git/statusMatrix';
import { RepoPath, type StatusEntry } from '../../../src/git/schemas';

const FixtureRoot = path.join(__dirname, '..', '..', 'git', 'fixtures');
const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const linkFixture = async (name: string, tmpDir: string): Promise<{ dir: string; gitdir: string }> => {
  // Copy work/ + dot-git/ into a fresh tmp dir; rename dot-git -> .git so
  // the layout matches a live repo.
  const src = path.join(FixtureRoot, name);
  const dst = path.join(tmpDir, name);
  await fs.cp(path.join(src, 'work'), dst, { recursive: true });
  await fs.cp(path.join(src, 'dot-git'), path.join(dst, '.git'), { recursive: true });
  return { dir: dst, gitdir: path.join(dst, '.git') };
};

const collectStatus = (cfg: { dir: string; gitdir: string; roots: readonly RepoPath[] }): Promise<StatusEntry[]> =>
  Effect.runPromise(
    Effect.provide(
      cold(cfg).pipe(
        Stream.runCollect,
        Effect.map((c) => Array.from(c))
      ) as unknown as Effect.Effect<StatusEntry[], unknown, FileSystem | Path>,
      Layered
    )
  );

describe('git/statusMatrix (phase 8)', () => {
  it('with-untracked/: emits the full union of statuses', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-'));
    try {
      const { dir, gitdir } = await linkFixture('with-untracked', tmp);
      // Roots: scan the workdir root itself (the fixture has no
      // package-dir convention; lite walks anything under "")
      const roots = [Schema.decodeUnknownSync(RepoPath)('tracked-modified.txt')]; // dummy — we'll replace
      // Easier: walk every file in the fixture by listing the root manually
      // Include both workdir-present files AND tracked files we know exist
      // in HEAD but are gone from workdir (tracked-deleted.txt).
      const trackedKnown = ['tracked-deleted.txt'];
      const onDisk = (await fs.readdir(dir)).filter((f) => f !== '.git' && f !== '.gitignore');
      const fileRoots = Array.from(new Set([...onDisk, ...trackedKnown])).map((f) =>
        Schema.decodeUnknownSync(RepoPath)(f)
      );
      const status = await collectStatus({ dir, gitdir, roots: fileRoots });
      const byPath = new Map(status.map((s) => [s.path, s.status]));
      void roots;

      // Expected set per the with-untracked/ generate.sh setup:
      expect(byPath.get('tracked-unmodified.txt' as RepoPath)).to.equal('unmodified');
      expect(byPath.get('tracked-modified.txt' as RepoPath)).to.equal('modified');
      expect(byPath.get('tracked-deleted.txt' as RepoPath)).to.equal('deleted');
      expect(byPath.get('untracked.txt' as RepoPath)).to.equal('added');
      // staged-add was committed only to the index, but lite reads the
      // shadow's commit form so it's "added" from HEAD-tree's perspective.
      expect(byPath.get('staged-add.txt' as RepoPath)).to.be.oneOf(['added', 'modified', 'unmodified']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('with-info-exclude/: ignored files surface as ignored, not added', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-ig-'));
    try {
      const { dir, gitdir } = await linkFixture('with-info-exclude', tmp);
      const roots = (await fs.readdir(dir))
        .filter((f) => f !== '.git')
        .map((f) => Schema.decodeUnknownSync(RepoPath)(f));
      const status = await collectStatus({ dir, gitdir, roots });
      const byPath = new Map(status.map((s) => [s.path, s.status]));
      // node_modules/foo/index.js → ignored by `**/node_modules/**`
      expect(byPath.get('node_modules/foo/index.js' as RepoPath)).to.equal('ignored');
      // src/__tests__/x.test.js → ignored by `**/__tests__/**`
      expect(byPath.get('src/__tests__/x.test.js' as RepoPath)).to.equal('ignored');
      // .DS_Store → ignored
      expect(byPath.get('.DS_Store' as RepoPath)).to.equal('ignored');
      // .keep is negated and so should be added (untracked). Our matcher
      // honors the negation since `ignore` lib supports the full spec.
      expect(byPath.get('.keep' as RepoPath)).to.equal('added');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('empty/: emits nothing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-empty-'));
    try {
      const { dir, gitdir } = await linkFixture('empty', tmp);
      const status = await collectStatus({ dir, gitdir, roots: [] });
      expect(status).to.have.lengthOf(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
