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
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { BadArgument, SystemError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { RefNotFoundError, WorkdirIoError } from './errors';
import { Oid, RefName } from './schemas';

const SYMBOLIC_PREFIX = 'ref: ';
const TEXT = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

const refFile = (path: Path, gitdir: string, ref: RefName): string => path.join(gitdir, ref);

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

const readUtf8 = (file: string) =>
  FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readFile(file).pipe(
        Effect.map((bytes) => Option.some(TEXT.decode(bytes))),
        Effect.catchAll((cause) =>
          isNotFound(cause)
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
        )
      )
    )
  );

const badArgumentError = (path: string, method: string, message: string): WorkdirIoError =>
  WorkdirIoError.fromPlatformError(path, new BadArgument({ module: 'FileSystem', method, description: message }));

/**
 * Read `.git/HEAD`. Returns a discriminated union: `'symbolic'` for the
 * `ref: refs/heads/main\n` form, `'direct'` for a bare oid (detached HEAD;
 * lite does not write this form but reads are supported for symmetry).
 * Fails with RefNotFoundError if HEAD itself is missing.
 */
type HeadValue =
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'direct'; readonly oid: Oid };

const HEAD_REF: RefName = Schema.decodeUnknownSync(RefName)('HEAD');

export const readHead = Effect.fn('readHead')(function* (gitdir: string) {
  const path = yield* Path;
  const file = refFile(path, gitdir, HEAD_REF);
  const raw = yield* readUtf8(file);
  return yield* Option.isNone(raw)
    ? Effect.fail(new RefNotFoundError({ ref: HEAD_REF, message: `HEAD missing at ${file}` }))
    : decodeHeadContent(file, raw.value.replace(/\n$/, ''));
});

const decodeHeadContent = (file: string, trimmed: string) =>
  trimmed.startsWith(SYMBOLIC_PREFIX)
    ? Either.match(Schema.decodeUnknownEither(RefName)(trimmed.slice(SYMBOLIC_PREFIX.length).trim()), {
        onLeft: () =>
          Effect.fail(
            badArgumentError(
              file,
              'readHead',
              `HEAD points to invalid ref "${trimmed.slice(SYMBOLIC_PREFIX.length).trim()}"`
            )
          ),
        onRight: (target) => Effect.succeed({ kind: 'symbolic', target } satisfies HeadValue),
      })
    : Either.match(Schema.decodeUnknownEither(Oid)(trimmed), {
        onLeft: () =>
          Effect.fail(
            badArgumentError(file, 'readHead', `HEAD content "${trimmed}" is neither a symbolic ref nor a 40-hex oid`)
          ),
        onRight: (oid) => Effect.succeed({ kind: 'direct', oid } satisfies HeadValue),
      });

/**
 * Read a leaf ref like `refs/heads/main` (40-hex + LF).
 */
export const readDirectRef = Effect.fn('readDirectRef')(function* (gitdir: string, ref: RefName) {
  const path = yield* Path;
  const file = refFile(path, gitdir, ref);
  const raw = yield* readUtf8(file);
  if (Option.isNone(raw)) {
    return yield* Effect.fail(new RefNotFoundError({ ref, message: `ref ${ref} missing at ${file}` }));
  }
  const trimmed = raw.value.replace(/\n$/, '').trim();
  return yield* Either.match(Schema.decodeUnknownEither(Oid)(trimmed), {
    onLeft: () =>
      Effect.fail(badArgumentError(file, 'readDirectRef', `ref ${ref} contains "${trimmed}", expected 40-hex`)),
    onRight: Effect.succeed,
  });
});

/**
 * Resolve a ref name to an oid. Single-hop deref: HEAD chains through
 * (symbolic→leaf) to oid; a leaf ref returns its oid directly. Lite has
 * no other ref types, so multi-hop deref is unnecessary.
 */
export const resolveRef = (gitdir: string, ref: RefName) =>
  ref === HEAD_REF
    ? readHead(gitdir).pipe(
        Effect.flatMap((head) =>
          head.kind === 'direct' ? Effect.succeed(head.oid) : readDirectRef(gitdir, head.target)
        )
      )
    : readDirectRef(gitdir, ref);

/**
 * Atomic-write-via-temp-rename. We write to `<file>.tmp.<rand>` (a
 * separate inode) and then `rename(tmp, file)`, which is atomic on POSIX
 * (within the same fs) and on Windows ≥ Vista. A crash or partial write
 * leaves the prior `<file>` bytes intact; readers never observe a
 * half-written ref.
 *
 * Real-git uses this pattern for ref writes; iso-git does not — its
 * `GitRefManager.writeRef` does a direct `fs.write(file)` under an
 * in-process lock, with a TODO comment about the crudeness. Lite picks
 * up the more correct pattern here.
 *
 * The randomized suffix is so two concurrent `writeAtomically` calls
 * across processes (the index.lock only serializes index writes, not
 * arbitrary ref writes) don't collide on a shared `<file>.tmp` name.
 */
const writeAtomically = Effect.fn('writeAtomically')(function* (gitdir: string, ref: RefName, bytes: Uint8Array) {
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
export const writeSymbolicHead = (gitdir: string, target: RefName) =>
  writeAtomically(gitdir, HEAD_REF, ENCODER.encode(`${SYMBOLIC_PREFIX}${target}\n`));

/**
 * Write a leaf ref (40-hex + LF) atomically via temp + rename.
 */
export const writeDirectRef = (gitdir: string, ref: RefName, oid: Oid) =>
  writeAtomically(gitdir, ref, ENCODER.encode(`${oid}\n`));
