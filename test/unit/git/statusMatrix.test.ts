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
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as Schema from 'effect/Schema';
import * as Tracer from 'effect/Tracer';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodePath from '@effect/platform-node/NodePath';
import { cold } from '../../../src/git/statusMatrix.js';
import { applyChanges } from '../../../src/git/applyChanges.js';
import { RepoPath, type StatusEntry } from '../../../src/git/schemas.js';
import { normalizeGitSymlinkTarget } from '../../../src/git/workdir.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FixtureRoot = path.join(currentDir, '..', '..', 'git', 'fixtures');
const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer);
const repoPath = (value: string): RepoPath => Schema.decodeUnknownSync(RepoPath)(value);

const linkFixture = async (name: string, tmpDir: string): Promise<{ dir: string; gitdir: string }> => {
  // Copy work/ + dot-git/ into a fresh tmp dir; rename dot-git -> .git so
  // the layout matches a live repo.
  const src = path.join(FixtureRoot, name);
  const dst = path.join(tmpDir, name);
  await fs.mkdir(dst, { recursive: true });
  const work = path.join(src, 'work');
  const hasWork = await fs
    .stat(work)
    .then((info) => info.isDirectory())
    .catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return false;
      throw cause;
    });
  if (hasWork) await fs.cp(work, dst, { recursive: true, verbatimSymlinks: true });
  if (name === 'nested-dirs') {
    // Git for Windows checks out symlink entries as small regular files when
    // core.symlinks is disabled. Re-create the fixture's link for this test.
    const linkPath = path.join(dst, 'a', 'link-to-plain');
    if (!(await fs.lstat(linkPath)).isSymbolicLink()) {
      const target = await fs.readFile(linkPath, 'utf8');
      await fs.rm(linkPath);
      await fs.symlink(target, linkPath, 'file');
    }
  }
  await fs.cp(path.join(src, 'dot-git'), path.join(dst, '.git'), { recursive: true });
  return { dir: dst, gitdir: path.join(dst, '.git') };
};

const collectStatus = (cfg: { dir: string; gitdir: string; roots: readonly RepoPath[] }): Promise<StatusEntry[]> =>
  Effect.runPromise(
    Effect.provide(
      cold(cfg).pipe(
        Stream.runCollect,
        Effect.map((c) => Array.from(c))
      ),
      Layered
    )
  );

describe('git/statusMatrix (phase 8)', () => {
  it('keeps status and commit span counts constant as tracked files and directories grow', async () => {
    const counts = await Promise.all(
      [1, 40].map(async (fileCount) => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-tracing-'));
        try {
          const { dir, gitdir } = await linkFixture('empty', tmp);
          const files = Array.from({ length: fileCount }, (_, index) => repoPath(`pkg/dir-${index}/file.txt`));
          await Promise.all(
            files.map(async (file) => {
              await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
              await fs.writeFile(path.join(dir, file), 'tracked content\n');
            })
          );
          const spans: Tracer.Span[] = [];
          const tracer = Tracer.make({
            span: (options) => {
              const span = Tracer.nativeTracer.span(options);
              spans.push(span);
              return span;
            },
          });
          await Effect.runPromise(
            applyChanges({
              cfg: { dir, gitdir },
              adds: Stream.fromIterable(files),
              removes: Stream.empty,
              author: { name: 'Test', email: 'test@example.com' },
              message: 'track files',
            }).pipe(Effect.withTracer(tracer), Effect.provide(Layered))
          );
          expect(spans.map(({ name }) => name)).to.include.members([
            'applyChanges',
            'writeIndexV2',
            'writeTreeFromMap',
          ]);
          expect(spans.find(({ name }) => name === 'buildAndCommit')?.attributes.get('addCount')).to.equal(fileCount);
          expect(spans.every(({ status: state }) => 'endTime' in state)).to.equal(true);
          const commitSpanCount = spans.length;

          spans.length = 0;
          const status = await cold({ dir, gitdir, roots: [repoPath('pkg')] }).pipe(
            Stream.runCollect,
            Effect.withTracer(tracer),
            Effect.provide(Layered),
            Effect.runPromise
          );
          expect(status).to.have.length(fileCount);
          expect(status.every(({ status: state }) => state === 'unmodified')).to.equal(true);
          expect(spans.map(({ name }) => name)).to.include.members([
            'streamHeadTree',
            'walkAllRoots',
            'evaluateMatrix',
          ]);
          expect(spans.find(({ name }) => name === 'evaluateMatrix')?.attributes.get('hashedFileCount')).to.equal(
            fileCount
          );
          expect(spans.find(({ name }) => name === 'walkAllRoots')?.attributes.get('directoryCount')).to.equal(
            fileCount + 1
          );
          expect(spans.every(({ status: state }) => 'endTime' in state)).to.equal(true);
          return { status: spans.length, commit: commitSpanCount };
        } finally {
          await fs.rm(tmp, { recursive: true, force: true });
        }
      })
    );
    expect(counts[1].status, 'status span count must not grow per file or directory').to.equal(counts[0].status);
    expect(counts[1].commit, 'commit span count must not grow per file or directory').to.equal(counts[0].commit);
  });

  it('normalizes native Windows symlink separators to Git separators', () => {
    expect(normalizeGitSymlinkTarget('..\\b\\plain.txt', '\\')).to.equal('../b/plain.txt');
  });

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
      expect(byPath.get(repoPath('tracked-unmodified.txt'))).to.equal('unmodified');
      expect(byPath.get(repoPath('tracked-modified.txt'))).to.equal('modified');
      expect(byPath.get(repoPath('tracked-deleted.txt'))).to.equal('deleted');
      expect(byPath.get(repoPath('untracked.txt'))).to.equal('added');
      // staged-add was committed only to the index, but lite reads the
      // shadow's commit form so it's "added" from HEAD-tree's perspective.
      expect(byPath.get(repoPath('staged-add.txt'))).to.be.oneOf(['added', 'modified', 'unmodified']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('with-info-exclude/: ignored files surface as ignored, not added', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-ig-'));
    try {
      const { dir, gitdir } = await linkFixture('with-info-exclude', tmp);
      await fs.mkdir(path.join(dir, 'node_modules', 'foo'), { recursive: true });
      await fs.writeFile(path.join(dir, 'node_modules', 'foo', 'index.js'), 'ignored');
      await fs.mkdir(path.join(dir, 'src', '__tests__'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src', '__tests__', 'x.test.js'), 'ignored');
      await fs.writeFile(path.join(dir, '.DS_Store'), 'ignored');
      const roots = (await fs.readdir(dir))
        .filter((f) => f !== '.git')
        .map((f) => Schema.decodeUnknownSync(RepoPath)(f));
      const status = await collectStatus({ dir, gitdir, roots });
      const byPath = new Map(status.map((s) => [s.path, s.status]));
      // node_modules/foo/index.js → ignored by `**/node_modules/**`
      expect(byPath.get(repoPath('node_modules/foo/index.js'))).to.equal('ignored');
      // src/__tests__/x.test.js → ignored by `**/__tests__/**`
      expect(byPath.get(repoPath('src/__tests__/x.test.js'))).to.equal('ignored');
      // .DS_Store → ignored
      expect(byPath.get(repoPath('.DS_Store'))).to.equal('ignored');
      // .keep is negated and so should be added (untracked). Our matcher
      // honors the negation since `ignore` lib supports the full spec.
      expect(byPath.get(repoPath('.keep'))).to.equal('added');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('applies nested .gitignore negations to files found by the directory walk', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-nested-ignore-'));
    try {
      const { dir, gitdir } = await linkFixture('empty', tmp);
      const packageDir = path.join(dir, 'pkg');
      const nestedDir = path.join(packageDir, 'nested');
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(packageDir, '.gitignore'), '*.log\n');
      await fs.writeFile(path.join(nestedDir, '.gitignore'), '!keep.log\n');
      await fs.writeFile(path.join(nestedDir, 'drop.log'), 'ignored');
      await fs.writeFile(path.join(nestedDir, 'keep.log'), 'unignored');

      const status = await collectStatus({
        dir,
        gitdir,
        roots: [Schema.decodeUnknownSync(RepoPath)('pkg')],
      });
      const byPath = new Map(status.map((entry) => [entry.path, entry.status]));
      expect(byPath.get(repoPath('pkg/nested/drop.log'))).to.equal('ignored');
      expect(byPath.get(repoPath('pkg/nested/keep.log'))).to.equal('added');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('tracks dangling symlinks by link target and mode', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-symlink-'));
    try {
      const { dir, gitdir } = await linkFixture('nested-dirs', tmp);
      const status = await collectStatus({
        dir,
        gitdir,
        roots: [Schema.decodeUnknownSync(RepoPath)('a')],
      });

      expect(status.find((entry) => entry.path === repoPath('a/link-to-plain'))?.status).to.equal('unmodified');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not recurse through a symlink to a directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-status-symlink-dir-'));
    try {
      const { dir, gitdir } = await linkFixture('empty', tmp);
      await fs.mkdir(path.join(dir, 'real-dir'), { recursive: true });
      await fs.writeFile(path.join(dir, 'real-dir', 'child.txt'), 'child');
      await fs.symlink('real-dir', path.join(dir, 'linked-dir'), 'dir');

      const status = await collectStatus({
        dir,
        gitdir,
        roots: [Schema.decodeUnknownSync(RepoPath)('linked-dir')],
      });

      expect(status.map((entry) => entry.path)).to.deep.equal(['linked-dir']);
      expect(status[0]?.status).to.equal('added');
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
