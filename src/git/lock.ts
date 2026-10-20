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
import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { RepoLockedError } from './errors.js';

const DEFAULT_TIMEOUT = Duration.seconds(600); // 10 minutes
const DEFAULT_AUTOCLEAR = Duration.seconds(300); // 5 minutes
const ENV_TIMEOUT = 'SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS';
const ENV_AUTOCLEAR = 'SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS';

const envDurationSeconds = (name: string, fallback: Duration.Duration) =>
  Config.Number(name)
    .pipe(Config.withDefault(Duration.toSeconds(fallback)))
    .parse(ConfigProvider.fromEnv())
    .pipe(
      Effect.map((seconds) => (Number.isFinite(seconds) && seconds > 0 ? Duration.seconds(seconds) : fallback)),
      Effect.catchTag('ConfigError', () => Effect.succeed(fallback))
    );

const statSentinel = Symbol('stat-not-found');

const humanReadable = (duration: Duration.Duration): string => Duration.format(duration);

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
  const [timeout, autoclear] = yield* Effect.all([
    envDurationSeconds(ENV_TIMEOUT, DEFAULT_TIMEOUT),
    envDurationSeconds(ENV_AUTOCLEAR, DEFAULT_AUTOCLEAR),
  ]);
  const timeoutMs = Duration.toMillis(timeout);
  const autoclearMs = Duration.toMillis(autoclear);
  const startMs = yield* Clock.currentTimeMillis;

  const tryAutoclear = Effect.fn('tryAutoclear')(function* () {
    const info = yield* fs
      .stat(lockPath)
      .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(statSentinel)));
    if (info === statSentinel) return false;
    const now = yield* Clock.currentTimeMillis;
    const mtimeMs = Option.getOrElse(
      Option.map(info.mtime, (mtime) => mtime.getTime()),
      () => now
    );
    const ageMs = now - mtimeMs;
    if (ageMs <= autoclearMs) return false;
    yield* Effect.logWarning(
      `lock auto-clear: ${lockPath} is ${humanReadable(Duration.millis(ageMs))} old (> ${humanReadable(autoclear)})`
    );
    yield* fs.remove(lockPath).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.void));
    return true;
  });

  // Single-attempt open; fails with RepoLockedError if the lock is held
  // (after auto-clear has had a chance), or PlatformError on real fs
  // failure. Effect.retry below drives the backoff loop, retrying only on
  // RepoLockedError.
  const wxOpen = Effect.scoped(fs.open(lockPath, { flag: 'wx' }));

  const lockedFailure = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const ageMs = now - startMs;
      return Effect.fail(
        new RepoLockedError({
          lockPath,
          ageMs,
          ageHumanReadable: humanReadable(Duration.millis(ageMs)),
          message: `index.lock at ${lockPath} held; waited ${humanReadable(Duration.millis(ageMs))}`,
        })
      );
    })
  );

  const tryAcquireOnce = Effect.fn('tryAcquireOnce')(function* () {
    const opened: boolean = yield* Effect.scoped(fs.open(lockPath, { flag: 'wx' })).pipe(
      Effect.map(() => true),
      Effect.catchReason('PlatformError', 'AlreadyExists', () => Effect.succeed(false))
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
  const backoff = Schedule.min([
    Duration.millis(50).pipe(Schedule.exponential, Schedule.jittered),
    Schedule.spaced(Duration.millis(1000)),
  ]).pipe(Schedule.upTo({ duration: timeout }));
  return yield* tryAcquireOnce().pipe(
    Effect.retry({ schedule: backoff, while: Schema.is(RepoLockedError) }),
    // After timeout, repackage with the canonical "remove manually" message.
    Effect.catchTag('RepoLockedError', () =>
      Effect.fail(
        new RepoLockedError({
          lockPath,
          ageMs: timeoutMs,
          ageHumanReadable: humanReadable(timeout),
          message: `index.lock at ${lockPath} not acquired within ${humanReadable(
            timeout
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
        ? fs.rename(lockPath, indexPath)
        : fs.remove(lockPath).pipe(
            Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
            Effect.catch((cause) => Effect.logWarning(`failed to remove ${lockPath}: ${cause.message}`))
          )
    )
  );

/**
 * Pipe-able lock combinator: hold `<gitdir>/index.lock` for the duration of
 * the piped effect. Release per strategy.
 *
 * @example
 * yield* writeIndexBytes(lockPath).pipe(withIndexLock(gitdir, 'rename-to-index'))
 *
 * // or, for non-index critical sections:
 * yield* applyChanges.pipe(withIndexLock(gitdir))
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
 * Variant that exposes the lockPath/indexPath to callers who write the new
 * index bytes into the lockfile before the atomic rename-to-index commit.
 */
export const withIndexLockCtx =
  (gitdir: string, strategy: ReleaseStrategy = 'rename-to-index') =>
  <A, E, R>(body: (ctx: { readonly lockPath: string; readonly indexPath: string }) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(acquireLock(gitdir), body, (ctx, exit) =>
      releaseLock(ctx.lockPath, ctx.indexPath, Exit.isSuccess(exit), strategy)
    );
