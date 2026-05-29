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

const oidFromBytes = (bytes: Uint8Array): Oid => {
  // eslint-disable-next-line functional/no-let
  let out = '';
  for (let i = 0; i < 20; i += 1) {
    const b = bytes[i] ?? 0;
    out += HEX[b >>> 4] ?? '';
    out += HEX[b & 0x0f] ?? '';
  }
  return Schema.decodeUnknownSync(Oid)(out);
};

/**
 * Decode a tree object body into entries. Real-git's encoding is
 * `<mode-as-octal-ascii> <name>\0<20-byte-oid>` repeated.
 */
const parseTreeObject = (oid: Oid, content: Uint8Array): Effect.Effect<readonly TreeEntry[], ObjectCorruptError> =>
  Effect.sync(() => {
    const entries: TreeEntry[] = [];
    // eslint-disable-next-line functional/no-let
    let offset = 0;
    // eslint-disable-next-line functional/no-loop-statements
    while (offset < content.byteLength) {
      const spIx = content.indexOf(SP, offset);
      if (spIx < 0) {
        throw new ObjectCorruptError({
          oid,
          reason: 'no SP after mode',
          message: `tree ${oid}: malformed entry header`,
        });
      }
      const modeStr = ASCII.decode(content.subarray(offset, spIx));
      const mode = Number.parseInt(modeStr, 8);
      if (!Number.isFinite(mode)) {
        throw new ObjectCorruptError({ oid, reason: `bad mode "${modeStr}"`, message: `tree ${oid}: bad mode` });
      }
      const nulIx = content.indexOf(0, spIx + 1);
      if (nulIx < 0) {
        throw new ObjectCorruptError({
          oid,
          reason: 'no NUL after name',
          message: `tree ${oid}: malformed entry name`,
        });
      }
      const name = ASCII.decode(content.subarray(spIx + 1, nulIx));
      const oidStart = nulIx + 1;
      const oidEnd = oidStart + 20;
      if (oidEnd > content.byteLength) {
        throw new ObjectCorruptError({
          oid,
          reason: 'truncated oid',
          message: `tree ${oid}: oid truncated for ${name}`,
        });
      }
      entries.push({ mode, name, oid: oidFromBytes(content.subarray(oidStart, oidEnd)) });
      offset = oidEnd;
    }
    return entries;
  });

/**
 * Recursive walk of a tree oid. Posix paths joined with `/`, depth-first
 * preorder per the entry order in each tree (real-git canonical: byte-wise
 * sort with directory suffix `/`). Submodule entries (mode 160000) are
 * emitted but not recursed.
 */
const SUBMODULE_MODE = 0o160000;
const TREE_MODE = 0o040000;

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
      Effect.flatMap((obj) => {
        if (obj.type !== 'tree') {
          return Effect.fail(
            new ObjectCorruptError({
              oid: treeOid,
              reason: `expected tree, got ${obj.type}`,
              message: `readTree ${treeOid}: not a tree`,
            })
          );
        }
        return parseTreeObject(treeOid, obj.content);
      }),
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
    const isTree = (e.mode & 0o170000) === TREE_MODE;
    if (e.mode === SUBMODULE_MODE) {
      // Submodule: emit but don't recurse (per spec).
      return Stream.succeed({ path: Schema.decodeUnknownSync(RepoPath)(fullPath), oid: e.oid });
    }
    if (isTree) {
      return readTree(gitdir, e.oid).pipe(
        Stream.map((child) => ({
          path: Schema.decodeUnknownSync(RepoPath)(`${fullPath}/${child.path}`),
          oid: child.oid,
        }))
      );
    }
    return Stream.succeed({ path: Schema.decodeUnknownSync(RepoPath)(fullPath), oid: e.oid });
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
      if (commit.type !== 'commit') {
        return yield* Effect.fail(
          new ObjectCorruptError({
            oid: headOid,
            reason: `expected commit, got ${commit.type}`,
            message: `streamHeadTree: HEAD oid ${headOid} is not a commit`,
          })
        );
      }
      // first line is `tree <oid>`
      const decoded = ASCII.decode(commit.content);
      const firstLine = decoded.split('\n', 1)[0] ?? '';
      const m = /^tree ([0-9a-f]{40})$/.exec(firstLine);
      if (m === null) {
        return yield* Effect.fail(
          new ObjectCorruptError({
            oid: headOid,
            reason: 'no tree line',
            message: `streamHeadTree: commit ${headOid} has no tree header`,
          })
        );
      }
      const treeOid = Schema.decodeUnknownSync(Oid)(m[1] ?? '');
      return readTree(gitdir, treeOid);
    })
  );
