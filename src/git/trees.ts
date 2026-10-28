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
/* eslint-disable functional/no-throw-statements --
 * Parser short-circuits via `throw new ObjectCorruptError(...)` from inside
 * `Effect.try`'s sync body. The throws never escape the Effect boundary.
 */
import * as Effect from 'effect/Effect';
import type { Crypto } from 'effect/Crypto';
import type { PlatformError } from 'effect/PlatformError';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as Schema from 'effect/Schema';
import { type FileSystem } from 'effect/FileSystem';
import { type Path } from 'effect/Path';
import { ObjectCorruptError, type ObjectNotFoundError, type RefNotFoundError } from './errors.js';
import { bytesToHex } from './bytes.js';
import { readLooseObject } from './objects.js';
import { resolveRef } from './refs.js';
import { Oid, RefName, RepoPath } from './schemas.js';

const ASCII = new TextDecoder('utf-8', { fatal: false });
const SP = 0x20;

type TreeEntry = {
  /** Posix mode as decimal-encoded ASCII in real-git: 040000, 100644, 100755, 120000, 160000 */
  readonly mode: number;
  /** A validated tree-entry basename; valid parents compose to a RepoPath. */
  readonly name: RepoPath;
  readonly oid: Oid;
};

// A bounds-checked 20-byte Git OID always hex-encodes to a valid Oid.
const oidFromBytes = (bytes: Uint8Array): Oid => bytesToHex(bytes.subarray(0, 20)) as Oid;

/**
 * Decode a tree object body into entries. Real-git's encoding is
 * `<mode-as-octal-ascii> <name>\0<20-byte-oid>` repeated.
 */
type ParsedTreeEntry = { readonly entry: TreeEntry; readonly nextOffset: number };

const parseOneTreeEntry = (oid: Oid, content: Uint8Array, offset: number): ParsedTreeEntry => {
  const spIx = content.indexOf(SP, offset);
  if (spIx < 0) {
    throw new ObjectCorruptError({ oid, reason: 'no SP after mode', message: `tree ${oid}: malformed entry header` });
  }
  const modeStr = ASCII.decode(content.subarray(offset, spIx));
  const mode = Number.parseInt(modeStr, 8);
  if (!Number.isFinite(mode)) {
    throw new ObjectCorruptError({ oid, reason: `bad mode "${modeStr}"`, message: `tree ${oid}: bad mode` });
  }
  const nulIx = content.indexOf(0, spIx + 1);
  if (nulIx < 0) {
    throw new ObjectCorruptError({ oid, reason: 'no NUL after name', message: `tree ${oid}: malformed entry name` });
  }
  const rawName = ASCII.decode(content.subarray(spIx + 1, nulIx));
  if (rawName.includes('/')) {
    throw new ObjectCorruptError({
      oid,
      reason: 'slash in tree entry name',
      message: `tree ${oid}: invalid entry name`,
    });
  }
  const name = Schema.decodeUnknownSync(RepoPath)(rawName);
  const oidStart = nulIx + 1;
  const oidEnd = oidStart + 20;
  if (oidEnd > content.byteLength) {
    throw new ObjectCorruptError({ oid, reason: 'truncated oid', message: `tree ${oid}: oid truncated for ${name}` });
  }
  return {
    entry: { mode, name, oid: oidFromBytes(content.subarray(oidStart, oidEnd)) },
    nextOffset: oidEnd,
  };
};

const parseTreeEntries = (oid: Oid, content: Uint8Array): readonly TreeEntry[] => {
  // Local builder: one append per entry, without copying prefixes or growing the call stack.
  const entries: TreeEntry[] = [];
  // eslint-disable-next-line functional/no-let
  let offset = 0;
  // eslint-disable-next-line functional/no-loop-statements
  while (offset < content.byteLength) {
    const parsed = parseOneTreeEntry(oid, content, offset);
    entries.push(parsed.entry);
    offset = parsed.nextOffset;
  }
  return entries;
};

const parseTreeObject = (oid: Oid, content: Uint8Array) =>
  Effect.try({
    try: (): readonly TreeEntry[] => parseTreeEntries(oid, content),
    catch: (e) =>
      Schema.is(ObjectCorruptError)(e)
        ? e
        : new ObjectCorruptError({ oid, reason: 'unexpected', message: `tree ${oid}: ${String(e)}` }),
  });

/**
 * Recursive walk of a tree oid. Posix paths joined with `/`, depth-first
 * preorder per the entry order in each tree (real-git canonical: byte-wise
 * sort with directory suffix `/`). Submodule entries (mode 160000) are
 * emitted but not recursed.
 */
const SUBMODULE_MODE = 0o16_0000;
const TREE_MODE = 0o04_0000;
export type HeadTreeEntry = { readonly path: RepoPath; readonly oid: Oid; readonly mode: number };

type TreeProfile = {
  treeObjects: number;
  treeContentBytes: number;
  readInflateVerifyMs: number;
  parseMs: number;
};

// These two helpers recurse through each other; annotations break TypeScript's
// return-type inference cycle for that recursive pair.
/* eslint-disable local-rules/no-explicit-effect-return-type */
const readTree = (
  gitdir: string,
  treeOid: Oid,
  profile?: TreeProfile
): Stream.Stream<HeadTreeEntry, ObjectNotFoundError | ObjectCorruptError | PlatformError, FileSystem | Path | Crypto> =>
  Stream.unwrap(
    (profile
      ? Effect.suspend(() => {
          const start = performance.now();
          return readLooseObject(gitdir, treeOid).pipe(
            Effect.tap((obj) =>
              Effect.sync(() => {
                profile.treeObjects += 1;
                profile.treeContentBytes += obj.content.byteLength;
                profile.readInflateVerifyMs += performance.now() - start;
              })
            )
          );
        })
      : readLooseObject(gitdir, treeOid)
    ).pipe(
      Effect.flatMap((obj) =>
        obj.type === 'tree'
          ? profile
            ? Effect.suspend(() => {
                const start = performance.now();
                return parseTreeObject(treeOid, obj.content).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      profile.parseMs += performance.now() - start;
                    })
                  )
                );
              })
            : parseTreeObject(treeOid, obj.content)
          : Effect.fail(
              new ObjectCorruptError({
                oid: treeOid,
                reason: `expected tree, got ${obj.type}`,
                message: `readTree ${treeOid}: not a tree`,
              })
            )
      ),
      Effect.map((entries) => buildStream(gitdir, entries, '', profile))
    )
  );

const buildStream = (
  gitdir: string,
  entries: readonly TreeEntry[],
  prefix: string,
  profile?: TreeProfile
): Stream.Stream<HeadTreeEntry, ObjectNotFoundError | ObjectCorruptError | PlatformError, FileSystem | Path | Crypto> =>
  Stream.flatMap(Stream.fromIterable(entries), (e) => {
    const fullPath = prefix.length === 0 ? e.name : `${prefix}/${e.name}`;
    // Submodules (mode 160000) are emitted but not recursed (per spec).
    return e.mode !== SUBMODULE_MODE && (e.mode & 0o17_0000) === TREE_MODE
      ? readTree(gitdir, e.oid, profile).pipe(
          Stream.map((child) => ({
            path: `${fullPath}/${child.path}` as RepoPath,
            oid: child.oid,
            mode: child.mode,
          }))
        )
      : Stream.succeed({ path: fullPath as RepoPath, oid: e.oid, mode: e.mode });
  });
/* eslint-enable local-rules/no-explicit-effect-return-type */

/** Resolve HEAD to a commit oid, then to its tree, preserving file modes. */
/* eslint-disable local-rules/no-explicit-effect-return-type -- keep the package declaration portable for consumers. */
export const streamHeadTreeWithMode = (
  gitdir: string,
  profile?: TreeProfile
): Stream.Stream<
  HeadTreeEntry,
  ObjectNotFoundError | ObjectCorruptError | RefNotFoundError | PlatformError,
  FileSystem | Path | Crypto
> =>
  /* eslint-enable local-rules/no-explicit-effect-return-type */
  Stream.unwrap(
    Effect.gen(function* () {
      const headOid = yield* resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('HEAD'));
      const commit = yield* readLooseObject(gitdir, headOid);
      const firstLine = ASCII.decode(commit.content).split('\n', 1)[0] ?? '';
      if (commit.type !== 'commit') {
        return yield* new ObjectCorruptError({
          oid: headOid,
          reason: `expected commit, got ${commit.type}`,
          message: `streamHeadTree: HEAD oid ${headOid} is not a commit`,
        });
      }
      const matched = yield* Effect.fromOption(
        Option.fromNullishOr(/^tree ([0-9a-f]{40})$/.exec(firstLine)),
        () =>
          new ObjectCorruptError({
            oid: headOid,
            reason: 'no tree line',
            message: `streamHeadTree: commit ${headOid} has no tree header`,
          })
      );
      return readTree(gitdir, Schema.decodeUnknownSync(Oid)(matched[1] ?? ''), profile);
    })
  ).pipe(Stream.withSpan('streamHeadTree'));

/** Resolve HEAD to a commit oid, then to its tree, projecting paths and oids. */
/** @internal */
export const streamHeadTree = (gitdir: string) =>
  streamHeadTreeWithMode(gitdir).pipe(Stream.map(({ path, oid }) => ({ path, oid })));
