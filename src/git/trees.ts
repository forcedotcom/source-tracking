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
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as Schema from 'effect/Schema';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { ObjectCorruptError, ObjectNotFoundError, type RefNotFoundError, type WorkdirIoError } from './errors';
import { readLooseObject } from './objects';
import { resolveRef } from './refs';
import { Oid, RefName, RepoPath } from './schemas';

const ASCII = new TextDecoder('utf-8', { fatal: false });
const HEX = '0123456789abcdef';
const SP = 0x20;

type TreeEntry = {
  /** Posix mode as decimal-encoded ASCII in real-git: 040000, 100644, 100755, 120000, 160000 */
  readonly mode: number;
  readonly name: string;
  readonly oid: Oid;
};

const hexNibble = (n: number): string => HEX[n] ?? '';

const oidFromBytes = (bytes: Uint8Array): Oid =>
  Schema.decodeUnknownSync(Oid)(
    Array.from(bytes.subarray(0, 20), (b) => `${hexNibble(b >>> 4)}${hexNibble(b & 0x0f)}`).join('')
  );

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
  const name = ASCII.decode(content.subarray(spIx + 1, nulIx));
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

const parseTreeEntries = (
  oid: Oid,
  content: Uint8Array,
  acc: readonly TreeEntry[],
  offset: number
): readonly TreeEntry[] => {
  if (offset >= content.byteLength) return acc;
  const { entry, nextOffset } = parseOneTreeEntry(oid, content, offset);
  return parseTreeEntries(oid, content, [...acc, entry], nextOffset);
};

const parseTreeObject = (oid: Oid, content: Uint8Array) =>
  Effect.try({
    try: (): readonly TreeEntry[] => parseTreeEntries(oid, content, [], 0),
    catch: (e) =>
      e instanceof ObjectCorruptError
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

const readTree = (
  gitdir: string,
  treeOid: Oid
): Stream.Stream<
  { readonly path: RepoPath; readonly oid: Oid },
  ObjectNotFoundError | ObjectCorruptError,
  FileSystem | Path
> =>
  Stream.unwrap(
    readLooseObject(gitdir, treeOid).pipe(
      Effect.flatMap((obj) =>
        obj.type === 'tree'
          ? parseTreeObject(treeOid, obj.content)
          : Effect.fail(
              new ObjectCorruptError({
                oid: treeOid,
                reason: `expected tree, got ${obj.type}`,
                message: `readTree ${treeOid}: not a tree`,
              })
            )
      ),
      Effect.map((entries) => buildStream(gitdir, entries, ''))
    )
  );

const buildStream = (
  gitdir: string,
  entries: readonly TreeEntry[],
  prefix: string
): Stream.Stream<
  { readonly path: RepoPath; readonly oid: Oid },
  ObjectNotFoundError | ObjectCorruptError,
  FileSystem | Path
> =>
  Stream.flatMap(Stream.fromIterable(entries), (e) => {
    const fullPath = prefix.length === 0 ? e.name : `${prefix}/${e.name}`;
    // Submodules (mode 160000) are emitted but not recursed (per spec).
    return e.mode !== SUBMODULE_MODE && (e.mode & 0o17_0000) === TREE_MODE
      ? readTree(gitdir, e.oid).pipe(
          Stream.map((child) => ({
            path: Schema.decodeUnknownSync(RepoPath)(`${fullPath}/${child.path}`),
            oid: child.oid,
          }))
        )
      : Stream.succeed({ path: Schema.decodeUnknownSync(RepoPath)(fullPath), oid: e.oid });
  });

/** Resolve HEAD to a commit oid, then to its tree, then walk it. */
export const streamHeadTree = (
  gitdir: string
): Stream.Stream<
  { readonly path: RepoPath; readonly oid: Oid },
  ObjectNotFoundError | ObjectCorruptError | RefNotFoundError | WorkdirIoError,
  FileSystem | Path
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const headOid = yield* resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('HEAD'));
      const commit = yield* readLooseObject(gitdir, headOid);
      const firstLine = ASCII.decode(commit.content).split('\n', 1)[0] ?? '';
      const matched = Option.fromNullable(/^tree ([0-9a-f]{40})$/.exec(firstLine));
      return commit.type !== 'commit'
        ? yield* Effect.fail(
            new ObjectCorruptError({
              oid: headOid,
              reason: `expected commit, got ${commit.type}`,
              message: `streamHeadTree: HEAD oid ${headOid} is not a commit`,
            })
          )
        : Option.isNone(matched)
        ? yield* Effect.fail(
            new ObjectCorruptError({
              oid: headOid,
              reason: 'no tree line',
              message: `streamHeadTree: commit ${headOid} has no tree header`,
            })
          )
        : readTree(gitdir, Schema.decodeUnknownSync(Oid)(matched.value[1] ?? ''));
    })
  );
