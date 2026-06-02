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
import { SystemError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import * as Effect from 'effect/Effect';
import * as Either from 'effect/Either';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { WorkdirIoError } from './errors';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: false });

/** Source-tracking sidecar dir under .git/. Opaque to other tooling. */
export const SIDECAR_DIR = 'sftracking';
export const SIDECAR_FILE = 'untr.json';

const sidecarPath = (path: Path, gitdir: string): { dir: string; file: string } => {
  const dir = path.join(gitdir, SIDECAR_DIR);
  return { dir, file: path.join(dir, SIDECAR_FILE) };
};

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

const UntrEntryStatus = Schema.Literal('added', 'ignored');
export type UntrEntryStatus = Schema.Schema.Type<typeof UntrEntryStatus>;

const UntrFingerprint = Schema.Struct({
  mtimeMs: Schema.Number,
  size: Schema.Number,
  /** mtime of the local `.gitignore` in this dir, or 0 if absent. */
  gitignoreMtimeMs: Schema.Number,
});
export type UntrFingerprint = Schema.Schema.Type<typeof UntrFingerprint>;

const UntrEntry = Schema.Struct({
  fingerprint: UntrFingerprint,
  /** Untracked basenames + their resolved `'added' | 'ignored'` status. */
  untracked: Schema.Array(Schema.Struct({ name: Schema.String, status: UntrEntryStatus })),
  /** Basenames of tracked files physically present in this dir at cache-write time. Lets warm reconstruct workdir-set without a walk. */
  trackedNames: Schema.Array(Schema.String),
});
export type UntrEntry = Schema.Schema.Type<typeof UntrEntry>;

/**
 * The wire shape: a HashMap keyed by directory path. Posix, workdir-relative.
 * The workdir root is the empty string `''`, both in memory and on the wire
 * (Schema.HashMap encodes as `Array<[K, V]>` so empty-string keys round-trip).
 */
export const UntrCache = Schema.Struct({
  /** Bumped only on incompatible semantic change. Additive fields go through `Schema.optional` defaults. */
  schemaVersion: Schema.Literal(1),
  /** mtime of `.git/info/exclude` at cache-write time; 0 if absent. Mismatch → whole-cache invalidate. */
  excludeMtimeMs: Schema.Number,
  entries: Schema.HashMap({ key: Schema.String, value: UntrEntry }),
});
export type UntrCache = Schema.Schema.Type<typeof UntrCache>;

/**
 * Bytes ↔ in-memory codec.
 *
 * `Schema.parseJson` produces a transformation `string ↔ UntrCache`. Pair it
 * with `TextEncoder` / `TextDecoder` at the FS boundary so the on-disk
 * artifact is one round-trip away from the in-memory `HashMap`-bearing
 * struct.
 */
export const UntrCacheJson = Schema.parseJson(UntrCache);

/**
 * Read the sidecar cache. Returns `None` for any failure mode — file
 * missing, JSON parse error, Schema decode error, schemaVersion mismatch,
 * truncated bytes. The warm path treats absence as "go cold," so silent
 * recovery is the right move.
 *
 * Returned tuple includes the sidecar's mtime so callers can drive the
 * "in-process Ref reload-on-mtime-advance" check without re-statting.
 */
export type LoadedUntrCache = { readonly mtimeMs: number; readonly cache: UntrCache };

export const readUntrCache = Effect.fn('readUntrCache')(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const { file } = sidecarPath(path, gitdir);
  const info = yield* fs.stat(file).pipe(Effect.either, Effect.map(Either.getRight));
  if (Option.isNone(info)) return Option.none<LoadedUntrCache>();
  const bytes = yield* fs.readFile(file).pipe(Effect.either, Effect.map(Either.getRight));
  if (Option.isNone(bytes)) return Option.none<LoadedUntrCache>();
  const decoded = yield* Schema.decode(UntrCacheJson)(DECODER.decode(bytes.value)).pipe(
    Effect.map(Option.some),
    Effect.catchAll((err) =>
      Effect.logTrace(`untr cache decode failed: ${err.message}`).pipe(
        Effect.zipRight(Effect.succeed(Option.none<UntrCache>()))
      )
    )
  );
  if (Option.isNone(decoded)) return Option.none<LoadedUntrCache>();
  const mtimeMs = Option.getOrElse(info.value.mtime, () => new Date(0)).getTime();
  return Option.some<LoadedUntrCache>({ mtimeMs, cache: decoded.value });
});

/**
 * Atomic temp+rename write. Mirrors [refs.ts:writeAtomically](./refs.ts#L141)
 * so a crash mid-write can't leave a torn cache; readers either see the
 * prior bytes or the new ones, never half-written.
 */
export const writeUntrCache = Effect.fn('writeUntrCache')(function* (gitdir: string, cache: UntrCache) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const { dir, file } = sidecarPath(path, gitdir);
  yield* Effect.annotateCurrentSpan({ entryCount: HashMap.size(cache.entries) });
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(dir, cause))));
  const json = Schema.encodeSync(UntrCacheJson)(cache);
  const tmp = `${file}.tmp.${Math.random().toString(36).slice(2)}`;
  yield* fs
    .writeFile(tmp, ENCODER.encode(json))
    .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(tmp, cause))));
  yield* fs
    .rename(tmp, file)
    .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(file, cause))));
});

/**
 * Best-effort delete. Used after a corruption signal so the next
 * `applyChanges` rebuilds. Failure is logged at trace level — the warm
 * path is non-load-bearing for correctness.
 */
export const deleteUntrCache = Effect.fn('deleteUntrCache')(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const { file } = sidecarPath(path, gitdir);
  yield* fs
    .remove(file)
    .pipe(
      Effect.catchAll((cause) =>
        isNotFound(cause) ? Effect.void : Effect.logTrace(`untr cache delete failed at ${file}: ${cause.message}`)
      )
    );
});
