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
import * as Either from 'effect/Either';
import * as Schema from 'effect/Schema';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { RefNotFoundError, WorkdirIoError } from './errors';
import { Oid, RefName } from './schemas';

const SYMBOLIC_PREFIX = 'ref: ';
const TEXT = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

const refFile = (path: Path, gitdir: string, ref: RefName): string => path.join(gitdir, ref);

const isNotFound = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'NotFound';

const readUtf8 = (file: string): Effect.Effect<string | null, WorkdirIoError, FileSystem> =>
  FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readFile(file).pipe(
        Effect.map((bytes): string | null => TEXT.decode(bytes)),
        Effect.catchAll(
          (cause): Effect.Effect<string | null, WorkdirIoError> =>
            isNotFound(cause as never)
              ? Effect.succeed(null)
              : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
        )
      )
    )
  );

const badArgumentError = (path: string, method: string, message: string): WorkdirIoError =>
  WorkdirIoError.fromPlatformError(path, {
    _tag: 'BadArgument',
    module: 'FileSystem',
    method,
    message,
  } as never);

/**
 * Read `.git/HEAD`. Returns a discriminated union: `'symbolic'` for the
 * `ref: refs/heads/main\n` form, `'direct'` for a bare oid (detached HEAD;
 * lite does not write this form but reads are supported for symmetry).
 * Fails with RefNotFoundError if HEAD itself is missing.
 */
export type HeadValue =
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'direct'; readonly oid: Oid };

const HEAD_REF: RefName = Schema.decodeUnknownSync(RefName)('HEAD');

export const readHead = (
  gitdir: string
): Effect.Effect<HeadValue, RefNotFoundError | WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const path = yield* Path;
    const file = refFile(path, gitdir, HEAD_REF);
    const raw = yield* readUtf8(file);
    if (raw === null) {
      return yield* Effect.fail(new RefNotFoundError({ ref: HEAD_REF, message: `HEAD missing at ${file}` }));
    }
    const trimmed = raw.replace(/\n$/, '');
    if (trimmed.startsWith(SYMBOLIC_PREFIX)) {
      const targetRaw = trimmed.slice(SYMBOLIC_PREFIX.length).trim();
      return yield* Either.match(Schema.decodeUnknownEither(RefName)(targetRaw), {
        onLeft: (): Effect.Effect<HeadValue, WorkdirIoError> =>
          Effect.fail(badArgumentError(file, 'readHead', `HEAD points to invalid ref "${targetRaw}"`)),
        onRight: (target): Effect.Effect<HeadValue, WorkdirIoError> =>
          Effect.succeed({ kind: 'symbolic', target } satisfies HeadValue),
      });
    }
    return yield* Either.match(Schema.decodeUnknownEither(Oid)(trimmed), {
      onLeft: (): Effect.Effect<HeadValue, WorkdirIoError> =>
        Effect.fail(
          badArgumentError(file, 'readHead', `HEAD content "${trimmed}" is neither a symbolic ref nor a 40-hex oid`)
        ),
      onRight: (oid): Effect.Effect<HeadValue, WorkdirIoError> =>
        Effect.succeed({ kind: 'direct', oid } satisfies HeadValue),
    });
  });

/**
 * Read a leaf ref like `refs/heads/main` (40-hex + LF).
 */
export const readDirectRef = (
  gitdir: string,
  ref: RefName
): Effect.Effect<Oid, RefNotFoundError | WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const path = yield* Path;
    const file = refFile(path, gitdir, ref);
    const raw = yield* readUtf8(file);
    if (raw === null) {
      return yield* Effect.fail(new RefNotFoundError({ ref, message: `ref ${ref} missing at ${file}` }));
    }
    const trimmed = raw.replace(/\n$/, '').trim();
    return yield* Either.match(Schema.decodeUnknownEither(Oid)(trimmed), {
      onLeft: () =>
        Effect.fail(
          badArgumentError(file, 'readDirectRef', `ref ${ref} contains "${trimmed}", expected 40-hex`)
        ) as Effect.Effect<Oid, WorkdirIoError>,
      onRight: (oid) => Effect.succeed(oid),
    });
  });

/**
 * Resolve a ref name to an oid. Single-hop deref: HEAD chains through
 * (symbolic→leaf) to oid; a leaf ref returns its oid directly. Lite has
 * no other ref types, so multi-hop deref is unnecessary.
 */
export const resolveRef = (
  gitdir: string,
  ref: RefName
): Effect.Effect<Oid, RefNotFoundError | WorkdirIoError, FileSystem | Path> =>
  ref === HEAD_REF
    ? readHead(gitdir).pipe(
        Effect.flatMap((head) =>
          head.kind === 'direct' ? Effect.succeed(head.oid) : readDirectRef(gitdir, head.target)
        )
      )
    : readDirectRef(gitdir, ref);

const writeAtomically = (
  gitdir: string,
  ref: RefName,
  bytes: Uint8Array
): Effect.Effect<void, WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const file = refFile(path, gitdir, ref);
    const tmp = `${file}.tmp.${Math.random().toString(36).slice(2)}`;
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(path.dirname(file), cause))));
    yield* fs
      .writeFile(tmp, bytes)
      .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(tmp, cause))));
    yield* fs
      .rename(tmp, file)
      .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(file, cause))));
  });

/**
 * Write `.git/HEAD` as a symbolic ref pointing at `target`.
 */
export const writeSymbolicHead = (
  gitdir: string,
  target: RefName
): Effect.Effect<void, WorkdirIoError, FileSystem | Path> =>
  writeAtomically(gitdir, HEAD_REF, ENCODER.encode(`${SYMBOLIC_PREFIX}${target}\n`));

/**
 * Write a leaf ref (40-hex + LF) atomically via temp + rename.
 */
export const writeDirectRef = (
  gitdir: string,
  ref: RefName,
  oid: Oid
): Effect.Effect<void, WorkdirIoError, FileSystem | Path> => writeAtomically(gitdir, ref, ENCODER.encode(`${oid}\n`));
