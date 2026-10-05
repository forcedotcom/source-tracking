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
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import { SystemError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { RepoLockedError, WorkdirIoError } from './errors';

const DEFAULT_TIMEOUT_SEC = 600; // 10 minutes
const DEFAULT_AUTOCLEAR_SEC = 300; // 5 minutes
const ENV_TIMEOUT = 'SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS';
const ENV_AUTOCLEAR = 'SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS';

const envSeconds = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const statSentinel = Symbol('stat-not-found');

const humanReadable = (ms: number): string => Duration.format(Duration.millis(ms));

const isAlreadyExists = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'AlreadyExists';

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

/**
 * Acquire `<gitdir>/index.lock` exclusively (`open({flag:'wx'})`), run the
 * piped effect while holding it, then release per strategy. Real-git
 * compatible.
 *
 * `'rename-to-index'` (default): on success, atomically renames the lockfile
 * to `<gitdir>/index`. The piped effect should have written the new index
 * bytes to `<gitdir>/index.lock` so the rename is the index-swap. On
 * failure, the lockfile is removed.
 *
 * `'remove'`: success and failure both remove the lockfile. Use when the
 * critical section doesn't write the index, e.g. operations that only
 * mutate refs/objects.
 */
export type ReleaseStrategy = 'rename-to-index' | 'remove';

const acquireLock = Effect.fn('acquireLock')(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const lockPath = path.join(gitdir, 'index.lock');
  const indexPath = path.join(gitdir, 'index');
  const timeoutMs = envSeconds(ENV_TIMEOUT, DEFAULT_TIMEOUT_SEC) * 1000;
  const autoclearMs = envSeconds(ENV_AUTOCLEAR, DEFAULT_AUTOCLEAR_SEC) * 1000;
  const startMs = yield* Clock.currentTimeMillis;

  const tryAutoclear = Effect.fn('tryAutoclear')(function* () {
    const info = yield* fs
      .stat(lockPath)
      .pipe(
        Effect.catchAll((cause) =>
          isNotFound(cause)
            ? Effect.succeed(statSentinel)
            : Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause))
        )
      );
    if (info === statSentinel) return false;
    const now = yield* Clock.currentTimeMillis;
    const mtimeMs = Option.getOrElse(info.mtime, () => new Date(now)).getTime();
    const ageMs = now - mtimeMs;
    if (ageMs <= autoclearMs) return false;
    yield* Effect.logWarning(
      `lock auto-clear: ${lockPath} is ${humanReadable(ageMs)} old (> ${humanReadable(autoclearMs)})`
    );
    yield* fs
      .remove(lockPath)
      .pipe(
        Effect.catchAll((cause) =>
          isNotFound(cause) ? Effect.void : Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause))
        )
      );
    return true;
  });

  // Single-attempt open; fails with RepoLockedError if the lock is held
  // (after auto-clear has had a chance), or WorkdirIoError on real fs
  // failure. Effect.retry below drives the backoff loop, retrying only on
  // RepoLockedError.
  const wxOpen = Effect.scoped(fs.open(lockPath, { flag: 'wx' })).pipe(
    Effect.catchAll((c) => Effect.fail(WorkdirIoError.fromPlatformError(lockPath, c)))
  );

  const lockedFailure = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const ageMs = now - startMs;
      return Effect.fail(
        new RepoLockedError({
          lockPath,
          ageMs,
          ageHumanReadable: humanReadable(ageMs),
          message: `index.lock at ${lockPath} held; waited ${humanReadable(ageMs)}`,
        })
      );
    })
  );

  const tryAcquireOnce = Effect.fn('tryAcquireOnce')(function* () {
    const opened: boolean = yield* Effect.scoped(fs.open(lockPath, { flag: 'wx' })).pipe(
      Effect.map(() => true),
      Effect.catchAll((cause) =>
        isAlreadyExists(cause) ? Effect.succeed(false) : Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause))
      )
    );
    return opened
      ? { lockPath, indexPath }
      : (yield* tryAutoclear())
      ? (yield* wxOpen, { lockPath, indexPath })
      : yield* lockedFailure;
  });

  // Native retry: exponential backoff jittered, capped at 1s spacing,
  // bounded by the user-configured timeout. The `while` predicate uses
  // an instanceof check on the tagged-error class — the structurally
  // typed discriminant Effect's tagged errors are designed for.
  const backoff = Schedule.exponential(Duration.millis(50)).pipe(
    Schedule.either(Schedule.spaced(Duration.millis(1000))),
    Schedule.jittered,
    Schedule.upTo(Duration.millis(timeoutMs))
  );
  return yield* tryAcquireOnce().pipe(
    Effect.retry({ schedule: backoff, while: (e) => e instanceof RepoLockedError }),
    // After timeout, repackage with the canonical "remove manually" message.
    Effect.catchTag('RepoLockedError', () =>
      Effect.fail(
        new RepoLockedError({
          lockPath,
          ageMs: timeoutMs,
          ageHumanReadable: humanReadable(timeoutMs),
          message: `index.lock at ${lockPath} not acquired within ${humanReadable(
            timeoutMs
          )}; remove manually if you are sure no other process is writing`,
        })
      )
    )
  );
});

const releaseLock = (lockPath: string, indexPath: string, succeeded: boolean, strategy: ReleaseStrategy) =>
  FileSystem.pipe(
    Effect.flatMap((fs) =>
      succeeded && strategy === 'rename-to-index'
        ? fs
            .rename(lockPath, indexPath)
            .pipe(
              Effect.catchAll((cause) =>
                Effect.logWarning(`failed to rename ${lockPath} → ${indexPath}: ${cause.message}`)
              )
            )
        : fs
            .remove(lockPath)
            .pipe(
              Effect.catchAll((cause) =>
                isNotFound(cause) ? Effect.void : Effect.logWarning(`failed to remove ${lockPath}: ${cause.message}`)
              )
            )
    )
  );

/**
 * Pipe-able lock combinator: hold `<gitdir>/index.lock` for the duration of
 * the piped effect. Release per strategy.
 *
 * @example
 *   yield* writeIndexBytes(lockPath).pipe(withIndexLock(gitdir, 'rename-to-index'))
 *
 *   // or, for non-index critical sections:
 *   yield* applyChanges.pipe(withIndexLock(gitdir))
 */
export const withIndexLock =
  (gitdir: string, strategy: ReleaseStrategy = 'remove') =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquireLock(gitdir),
      () => self,
      (ctx, exit) => releaseLock(ctx.lockPath, ctx.indexPath, Exit.isSuccess(exit), strategy)
    );

/**
 * Variant that exposes the lockPath/indexPath to callers who need to write
 * the new index bytes into the lockfile before the rename-to-index commit.
 * Phase 9's applyChanges uses the simpler `withIndexLock` (strategy:
 * 'remove') and writes the index out-of-band; this hook stays for callers
 * that want truly atomic index replacement.
 */
export const withIndexLockCtx =
  (gitdir: string, strategy: ReleaseStrategy = 'rename-to-index') =>
  <A, E, R>(body: (ctx: { readonly lockPath: string; readonly indexPath: string }) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquireLock(gitdir),
      (ctx) => body(ctx),
      (ctx, exit) => releaseLock(ctx.lockPath, ctx.indexPath, Exit.isSuccess(exit), strategy)
    );
