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
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import { isNull } from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { withIndexLock, withIndexLockCtx } from '../../../src/git/lock.js';
import { RepoLockedError } from '../../../src/git/errors.js';

class TestFailure extends Schema.TaggedError<TestFailure>()('TestFailure', {
  message: Schema.String,
}) {}

class LockWorkerError extends Schema.TaggedError<LockWorkerError>()('LockWorkerError', {
  message: Schema.String,
}) {}

const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const run = <A, E>(eff: Effect.Effect<A, E, FileSystem | Path>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.provide(eff, TestLayer));

const mkGitdir = async (): Promise<{ tmp: string; gitdir: string }> => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-lock-'));
  const gitdir = path.join(tmp, '.git');
  await fs.mkdir(gitdir, { recursive: true });
  return { tmp, gitdir };
};

const startLockWorker = (
  role: string,
  gitdir: string,
  logPath: string,
  autoclearSeconds = '3600',
  holdMs = '0',
  releaseSignal = ''
): {
  child: ChildProcess;
  closed: Effect.Effect<void, LockWorkerError>;
  waitForOutput: (marker: string) => Effect.Effect<void, LockWorkerError>;
} => {
  const workerPath = fileURLToPath(new URL('./lockWorker.ts', import.meta.url));
  const child = spawn(process.execPath, ['--loader', 'ts-node/esm', workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TS_NODE_LOG_ERROR: 'true',
      TS_NODE_TRANSPILE_ONLY: 'true',
      TS_NODE_PROJECT: path.resolve('test/tsconfig.json'),
      LOCK_TEST_ROLE: role,
      LOCK_TEST_GITDIR: gitdir,
      LOCK_TEST_LOG: logPath,
      LOCK_TEST_HOLD_MS: holdMs,
      LOCK_TEST_RELEASE_SIGNAL: releaseSignal,
      SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS: autoclearSeconds,
      SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = Effect.callback<void, LockWorkerError>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(new LockWorkerError({ message: error.message })));
    const onClose = (code: number | null) =>
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(new LockWorkerError({ message: `lock worker ${role} exited ${code}: ${stderr} ${stdout}` }))
      );
    child.once('error', onError);
    child.once('close', onClose);
    return Effect.sync(() => {
      child.off('error', onError);
      child.off('close', onClose);
    });
  });
  const waitForOutput = (marker: string) =>
    Effect.callback<void, LockWorkerError>((resume) => {
      const onError = (error: Error) => {
        const failure = Effect.fail(new LockWorkerError({ message: error.message }));
        finish(failure);
      };
      const onClose = (code: number | null) => {
        if (!stdout.includes(marker)) {
          const failure = Effect.fail(
            new LockWorkerError({ message: `lock worker ${role} exited ${code} before ${marker}: ${stderr} ${stdout}` })
          );
          finish(failure);
        }
      };
      const finish = (effect: Effect.Effect<void, LockWorkerError>) => {
        cleanup();
        resume(effect);
      };
      const check = () => {
        if (stdout.includes(marker)) finish(Effect.void);
      };
      const cleanup = () => {
        child.stdout?.off('data', check);
        child.off('error', onError);
        child.off('close', onClose);
      };
      if (stdout.includes(marker)) {
        resume(Effect.void);
        return;
      }
      child.stdout?.on('data', check);
      child.once('error', onError);
      child.once('close', onClose);
      return Effect.sync(cleanup);
    });
  return { child, closed, waitForOutput };
};

describe('git/lock (phase 4)', () => {
  it('rename-to-index strategy moves the lockfile into place on success', async () => {
    const { tmp, gitdir } = await mkGitdir();
    try {
      const exit = await run(
        withIndexLockCtx(
          gitdir,
          'rename-to-index'
        )((ctx) =>
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
      const exit = await run(new TestFailure({ message: 'boom' }).pipe(withIndexLock(gitdir)));
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
        Effect.gen(function* () {
          order.push('a-start');
          yield* Effect.sleep('50 millis');
          order.push('a-end');
          return 'a';
        }).pipe(withIndexLock(gitdir))
      );
      // small delay so a definitely starts first
      await Effect.runPromise(Effect.sleep('5 millis'));
      const b = run(
        Effect.sync(() => {
          order.push('b-start');
          return 'b';
        }).pipe(withIndexLock(gitdir))
      );
      const [exitA, exitB] = await Promise.all([a, b]);
      expect(Exit.isSuccess(exitA)).to.equal(true);
      expect(Exit.isSuccess(exitB)).to.equal(true);
      expect(order).to.deep.equal(['a-start', 'a-end', 'b-start']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('serializes lock acquisition across separate processes', async () => {
    const { tmp, gitdir } = await mkGitdir();
    const logPath = path.join(tmp, 'lock-events.log');
    const releaseSignal = path.join(tmp, 'release-first');
    const children: ChildProcess[] = [];
    try {
      const first = startLockWorker('first', gitdir, logPath, '3600', '0', releaseSignal);
      children.push(first.child);
      const firstClosed = Effect.runPromise(first.closed);
      await Effect.runPromise(first.waitForOutput('first-acquired'));

      const second = startLockWorker('second', gitdir, logPath);
      children.push(second.child);
      await Effect.runPromise(second.waitForOutput('second-attempting'));
      await Effect.runPromise(Effect.sleep('100 millis'));
      await fs.writeFile(releaseSignal, 'release');
      await Promise.all([firstClosed, Effect.runPromise(second.closed)]);
      expect(await fs.readFile(logPath, 'utf8')).to.equal('first:start\nfirst:end\nsecond:start\nsecond:end\n');
    } finally {
      children.forEach((child) => {
        if (isNull(child.exitCode)) child.kill();
      });
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }).timeout(15000);

  it('clears a stale lock from a separate process', async () => {
    const { tmp, gitdir } = await mkGitdir();
    const logPath = path.join(tmp, 'lock-events.log');
    const staleLock = path.join(gitdir, 'index.lock');
    await fs.writeFile(staleLock, 'stale');
    await fs.utimes(staleLock, 0, 0);
    const worker = startLockWorker('stale', gitdir, logPath, '1');
    try {
      await Effect.runPromise(worker.closed);
      expect(await fs.readFile(logPath, 'utf8')).to.equal('stale:start\nstale:end\n');
      const lockExists = await fs
        .access(staleLock)
        .then(() => true)
        .catch(() => false);
      expect(lockExists).to.equal(false);
    } finally {
      if (isNull(worker.child.exitCode)) worker.child.kill();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }).timeout(15000);

  it('stale lock older than autoclear threshold is auto-cleared', async () => {
    const { tmp, gitdir } = await mkGitdir();
    process.env.SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS = '1';
    try {
      // Plant a stale lock (mtime well past 1s)
      const stale = path.join(gitdir, 'index.lock');
      await fs.writeFile(stale, 'stale');
      await fs.utimes(stale, 0, 0);

      const exit = await run(Effect.succeed('ok').pipe(withIndexLock(gitdir)));
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
      const exit = await run(Effect.succeed('ok').pipe(withIndexLock(gitdir)));
      expect(Exit.isFailure(exit)).to.equal(true);
      if (Exit.isFailure(exit)) {
        const fail = Cause.findErrorOption(exit.cause);
        if (Option.isSome(fail)) {
          expect(fail.value).to.be.instanceOf(RepoLockedError);
          if (Schema.is(RepoLockedError)(fail.value)) {
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
