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
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { withIndexLock, withSimpleLock } from '../../../src/git/lock';
import { RepoLockedError } from '../../../src/git/errors';

const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const run = <A, E>(eff: Effect.Effect<A, E, FileSystem | Path>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.provide(eff, TestLayer));

const mkGitdir = async (): Promise<{ tmp: string; gitdir: string }> => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-lock-'));
  const gitdir = path.join(tmp, '.git');
  await fs.mkdir(gitdir, { recursive: true });
  return { tmp, gitdir };
};

describe('git/lock (phase 4)', () => {
  it('rename-to-index strategy moves the lockfile into place on success', async () => {
    const { tmp, gitdir } = await mkGitdir();
    try {
      const exit = await run(
        withIndexLock(gitdir)((ctx) =>
          Effect.gen(function* () {
            const platform = yield* FileSystem;
            const bytes = new TextEncoder().encode('fresh-index-bytes');
            yield* platform.writeFile(ctx.lockPath, bytes);
            return ctx;
          })
        )
      );
      expect(Exit.isSuccess(exit)).to.equal(true);
      const indexBytes = await fs.readFile(path.join(gitdir, 'index'), 'utf-8');
      expect(indexBytes).to.equal('fresh-index-bytes');
      // lockfile should be gone (renamed to index)
      const lockExists = await fs
        .access(path.join(gitdir, 'index.lock'))
        .then(() => true)
        .catch(() => false);
      expect(lockExists).to.equal(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('failure inside the effect removes the lockfile (no orphan)', async () => {
    const { tmp, gitdir } = await mkGitdir();
    try {
      const exit = await run(withSimpleLock(gitdir)(Effect.fail(new Error('boom'))));
      expect(Exit.isFailure(exit)).to.equal(true);
      const lockExists = await fs
        .access(path.join(gitdir, 'index.lock'))
        .then(() => true)
        .catch(() => false);
      expect(lockExists).to.equal(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('two concurrent locks serialize (in-process)', async () => {
    const { tmp, gitdir } = await mkGitdir();
    try {
      const order: string[] = [];
      const a = run(
        withSimpleLock(gitdir)(
          Effect.gen(function* () {
            order.push('a-start');
            yield* Effect.sleep('50 millis');
            order.push('a-end');
            return 'a';
          })
        )
      );
      // small delay so a definitely starts first
      await new Promise((r) => setTimeout(r, 5));
      const b = run(
        withSimpleLock(gitdir)(
          Effect.sync(() => {
            order.push('b-start');
            return 'b';
          })
        )
      );
      const [exitA, exitB] = await Promise.all([a, b]);
      expect(Exit.isSuccess(exitA)).to.equal(true);
      expect(Exit.isSuccess(exitB)).to.equal(true);
      expect(order).to.deep.equal(['a-start', 'a-end', 'b-start']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('stale lock older than autoclear threshold is auto-cleared', async () => {
    const { tmp, gitdir } = await mkGitdir();
    process.env.SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS = '1';
    try {
      // Plant a stale lock (mtime well past 1s)
      const stale = path.join(gitdir, 'index.lock');
      await fs.writeFile(stale, 'stale');
      const ancient = new Date(Date.now() - 60_000);
      await fs.utimes(stale, ancient, ancient);

      const exit = await run(withSimpleLock(gitdir)(Effect.succeed('ok')));
      expect(Exit.isSuccess(exit)).to.equal(true);
    } finally {
      delete process.env.SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('lock held past timeout → RepoLockedError', async () => {
    const { tmp, gitdir } = await mkGitdir();
    process.env.SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS = '1';
    process.env.SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS = '3600';
    try {
      // Plant a young lock
      await fs.writeFile(path.join(gitdir, 'index.lock'), 'held');
      const exit = await run(withSimpleLock(gitdir)(Effect.succeed('ok')));
      expect(Exit.isFailure(exit)).to.equal(true);
      if (Exit.isFailure(exit)) {
        const fail = Cause.failureOption(exit.cause);
        if (Option.isSome(fail)) {
          expect(fail.value).to.be.instanceOf(RepoLockedError);
          if (fail.value instanceof RepoLockedError) {
            expect(fail.value.ageMs).to.be.greaterThan(0);
            expect(fail.value.ageHumanReadable).to.be.a('string');
          }
        }
      }
    } finally {
      delete process.env.SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS;
      delete process.env.SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }).timeout(8000);
});
