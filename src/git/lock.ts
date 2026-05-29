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

const isAlreadyExists = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'AlreadyExists';

const isNotFound = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'NotFound';

/**
 * Acquire `<gitdir>/index.lock` exclusively (`open({flag:'wx'})`), run the
 * piped effect while holding it, then release per strategy. Real-git
 * compatible — see [isogit-migration.md §Cross-process locking](../../isogit-migration.md#L133).
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
        Effect.catchAll(
          (cause): Effect.Effect<typeof statSentinel, WorkdirIoError> =>
            isNotFound(cause as never)
              ? Effect.succeed(statSentinel)
              : Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause))
        )
      );
    if (info === statSentinel) return false;
    const now = yield* Clock.currentTimeMillis;
    // eslint-disable-next-line no-underscore-dangle
    const mtimeMs = info.mtime._tag === 'Some' ? info.mtime.value.getTime() : now;
    const ageMs = now - mtimeMs;
    if (ageMs <= autoclearMs) return false;
    yield* Effect.logWarning(
      `lock auto-clear: ${lockPath} is ${humanReadable(ageMs)} old (> ${humanReadable(autoclearMs)})`
    );
    yield* fs
      .remove(lockPath)
      .pipe(
        Effect.catchAll(
          (cause): Effect.Effect<void, WorkdirIoError> =>
            isNotFound(cause as never) ? Effect.void : Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause))
        )
      );
    return true;
  });

  const tryAcquireOnce = Effect.fn('tryAcquireOnce')(function* () {
    const result: RepoLockedError | null = yield* Effect.scoped(
      fs.open(lockPath, { flag: 'wx' }).pipe(
        Effect.map((): RepoLockedError | null => null),
        Effect.catchAll((cause): Effect.Effect<RepoLockedError | null, WorkdirIoError> => {
          if (!isAlreadyExists(cause as never)) {
            return Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause));
          }
          return tryAutoclear().pipe(
            Effect.flatMap((cleared) =>
              cleared
                ? Effect.succeed(null)
                : Clock.currentTimeMillis.pipe(
                    Effect.map((now) => {
                      const ageMs = now - startMs;
                      return new RepoLockedError({
                        lockPath,
                        ageMs,
                        ageHumanReadable: humanReadable(ageMs),
                        message: `index.lock at ${lockPath} held; waited ${humanReadable(ageMs)}`,
                      });
                    })
                  )
            )
          );
        })
      )
    );
    return result;
  });

  // Backoff loop — null means we hold the lock; non-null means keep trying.
  // eslint-disable-next-line functional/no-let
  let elapsed = 0;
  // eslint-disable-next-line functional/no-loop-statements
  while (elapsed < timeoutMs) {
    const result = yield* tryAcquireOnce();
    if (result === null) return { lockPath, indexPath };
    const next = Math.min(50 * 2 ** Math.min(elapsed / 100, 5) + Math.random() * 50, 1000);
    yield* Clock.sleep(Duration.millis(next));
    const now = yield* Clock.currentTimeMillis;
    elapsed = now - startMs;
  }
  return yield* Effect.fail(
    new RepoLockedError({
      lockPath,
      ageMs: timeoutMs,
      ageHumanReadable: humanReadable(timeoutMs),
      message: `index.lock at ${lockPath} not acquired within ${humanReadable(
        timeoutMs
      )}; remove manually if you are sure no other process is writing`,
    })
  );
});

const releaseLock = (
  lockPath: string,
  indexPath: string,
  succeeded: boolean,
  strategy: ReleaseStrategy
): Effect.Effect<void, never, FileSystem> =>
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
                isNotFound(cause as never)
                  ? Effect.void
                  : Effect.logWarning(`failed to remove ${lockPath}: ${cause.message}`)
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
  <A, E, R>(
    self: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | RepoLockedError | WorkdirIoError, R | FileSystem | Path> =>
    Effect.acquireUseRelease(
      acquireLock(gitdir),
      () => self,
      (ctx, exit) =>
        // eslint-disable-next-line no-underscore-dangle
        releaseLock(ctx.lockPath, ctx.indexPath, exit._tag === 'Success', strategy)
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
  <A, E, R>(
    body: (ctx: { readonly lockPath: string; readonly indexPath: string }) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | RepoLockedError | WorkdirIoError, R | FileSystem | Path> =>
    Effect.acquireUseRelease(
      acquireLock(gitdir),
      (ctx) => body(ctx),
      (ctx, exit) =>
        // eslint-disable-next-line no-underscore-dangle
        releaseLock(ctx.lockPath, ctx.indexPath, exit._tag === 'Success', strategy)
    );
