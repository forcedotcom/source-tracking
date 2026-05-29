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
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import * as Duration from 'effect/Duration';
import * as Clock from 'effect/Clock';
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

const lockPathOf = (path: Path, gitdir: string): string => path.join(gitdir, 'index.lock');

const statSentinel = Symbol('stat-not-found');

const humanReadable = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
};

const isAlreadyExists = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'AlreadyExists';

const isNotFound = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'NotFound';

/**
 * Acquire `<gitdir>/index.lock` exclusively (`open({flag:'wx'})`), run the
 * effect while holding it, then atomically move the lockfile into place as
 * `<gitdir>/index` on success or remove it on failure. Real-git compatible —
 * see [isogit-migration.md §Cross-process locking](../../isogit-migration.md#L133).
 *
 * **Important contract:** the effect's job is to *write the new index bytes*
 * into the open lock file (via the returned `lockPath`). Phase 9's
 * applyChanges streams index bytes into this path before returning, then
 * `withIndexLock`'s success branch renames it to `index`. For uses that
 * don't need to atomically replace the index (e.g. phase 5's init, which
 * has no prior index), pass `releaseStrategy: 'remove'` so the success path
 * removes the lockfile instead of renaming it.
 */
export type ReleaseStrategy = 'rename-to-index' | 'remove';

export type LockContext = {
  readonly lockPath: string;
  readonly indexPath: string;
};

export const withIndexLock =
  (gitdir: string, releaseStrategy: ReleaseStrategy = 'rename-to-index') =>
  <A, E, R>(
    effect: (ctx: LockContext) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | RepoLockedError | WorkdirIoError, R | FileSystem | Path> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const lockPath = lockPathOf(path, gitdir);
      const indexPath = path.join(gitdir, 'index');
      const timeoutMs = envSeconds(ENV_TIMEOUT, DEFAULT_TIMEOUT_SEC) * 1000;
      const autoclearMs = envSeconds(ENV_AUTOCLEAR, DEFAULT_AUTOCLEAR_SEC) * 1000;
      const startMs = yield* Clock.currentTimeMillis;

      const tryAutoclear = (): Effect.Effect<boolean, WorkdirIoError> =>
        fs.stat(lockPath).pipe(
          Effect.catchAll(
            (cause): Effect.Effect<typeof statSentinel, WorkdirIoError> =>
              isNotFound(cause as never)
                ? Effect.succeed(statSentinel)
                : Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause))
          ),
          Effect.flatMap((info) => {
            if (info === statSentinel) return Effect.succeed(false);
            return Effect.gen(function* () {
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
                      isNotFound(cause as never)
                        ? Effect.void
                        : Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause))
                  )
                );
              return true;
            });
          })
        );

      const tryAcquireOnce = (): Effect.Effect<RepoLockedError | null, WorkdirIoError> =>
        Effect.scoped(
          fs.open(lockPath, { flag: 'wx' }).pipe(
            Effect.map((): RepoLockedError | null => null),
            Effect.catchAll((cause): Effect.Effect<RepoLockedError | null, WorkdirIoError> => {
              if (!isAlreadyExists(cause as never)) {
                return Effect.fail(WorkdirIoError.fromPlatformError(lockPath, cause));
              }
              // EEXIST: try the auto-clear path; if cleared, the next attempt
              // will succeed; if not yet stale, surface as "still locked".
              return tryAutoclear().pipe(
                Effect.flatMap((cleared) =>
                  cleared
                    ? Effect.succeed(null)
                    : Effect.gen(function* () {
                        const now = yield* Clock.currentTimeMillis;
                        const ageMs = now - startMs;
                        return new RepoLockedError({
                          lockPath,
                          ageMs,
                          ageHumanReadable: humanReadable(ageMs),
                          message: `index.lock at ${lockPath} held; waited ${humanReadable(ageMs)}`,
                        });
                      })
                )
              );
            })
          )
        );

      // Backoff schedule with jitter, capped at ~1s, until total elapsed
      // hits timeoutMs. We poll tryAcquireOnce; null means we hold the
      // lock, RepoLockedError means we still don't and should keep trying.
      const acquired = yield* Effect.gen(function* () {
        // eslint-disable-next-line functional/no-let
        let elapsed = 0;
        // eslint-disable-next-line functional/no-loop-statements
        while (elapsed < timeoutMs) {
          const result = yield* tryAcquireOnce();
          if (result === null) return null; // success
          // sleep with exponential backoff, jittered, capped at 1s
          const next = Math.min(50 * 2 ** Math.min(elapsed / 100, 5) + Math.random() * 50, 1000);
          yield* Clock.sleep(Duration.millis(next));
          const now = yield* Clock.currentTimeMillis;
          elapsed = now - startMs;
        }
        return new RepoLockedError({
          lockPath,
          ageMs: timeoutMs,
          ageHumanReadable: humanReadable(timeoutMs),
          message: `index.lock at ${lockPath} not acquired within ${humanReadable(
            timeoutMs
          )}; remove manually if you are sure no other process is writing`,
        });
      });
      if (acquired !== null) return yield* Effect.fail(acquired);

      // We hold the lock. Run the effect; on success, release per strategy;
      // on failure, always remove the lock so we don't leave a stale file.
      return yield* Effect.acquireUseRelease(Effect.succeed({ lockPath, indexPath }), effect, (_, exit) =>
        // eslint-disable-next-line no-underscore-dangle
        exit._tag === 'Success' && releaseStrategy === 'rename-to-index'
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
      );
    });

/**
 * Convenience wrapper for callers that don't need atomic-rename semantics —
 * just "hold a lock while running this effect, release on the way out".
 */
export const withSimpleLock =
  (gitdir: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | RepoLockedError | WorkdirIoError, R | FileSystem | Path> =>
    withIndexLock(gitdir, 'remove')(() => effect);

/**
 * Schedule helper for callers that need their own polling loop. Phase 9's
 * applyChanges uses `withIndexLock` directly; this is for tests + edge cases.
 */
export const lockBackoffSchedule = Schedule.exponential(Duration.millis(50)).pipe(
  Schedule.either(Schedule.spaced(Duration.millis(1000))),
  Schedule.jittered
);
