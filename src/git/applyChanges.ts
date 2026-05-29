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
import * as Clock from 'effect/Clock';
import * as Schema from 'effect/Schema';
import * as HashSet from 'effect/HashSet';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { type IndexCorruptError, type RefNotFoundError, RepoLockedError, WorkdirIoError } from './errors';
import { withIndexLock } from './lock';
import { writeLooseObject } from './objects';
import { readDirectRef, writeDirectRef } from './refs';
import { readIndex, type IndexEntry } from './indexV2';
import { type Author, type CommitOid, RefName, type RepoPath } from './schemas';
import { buildTreeMap, hashTreeFromMap, writeCommit, writeIndexV2, writeTreeFromMap } from './writers';

const MAIN_REF: RefName = Schema.decodeUnknownSync(RefName)('refs/heads/main');

const readWorkdirBytes = (dir: string, rel: RepoPath): Effect.Effect<Uint8Array, WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const abs = path.join(dir, rel);
    return yield* fs
      .readFile(abs)
      .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))));
  });

export type ApplyArgs = {
  readonly cfg: { readonly dir: string; readonly gitdir: string };
  readonly adds: Stream.Stream<RepoPath>;
  readonly removes: Stream.Stream<RepoPath>;
  readonly message: string;
  readonly author: Author;
};

/**
 * applyChanges = stage adds, drop removes, write tree+commit, advance HEAD
 * branch ref. All inside withIndexLock so concurrent writers serialize.
 *
 * Empty-streams short-circuit per the spec: returns the current HEAD oid
 * without creating a new commit.
 */
export const applyChanges = (
  args: ApplyArgs
): Effect.Effect<
  CommitOid,
  WorkdirIoError | IndexCorruptError | RefNotFoundError | RepoLockedError,
  FileSystem | Path
> =>
  Effect.gen(function* () {
    // Dedup adds/removes via HashSet<RepoPath> per the spec.
    const addsSet = yield* args.adds.pipe(Stream.runFold(HashSet.empty<RepoPath>(), (acc, p) => HashSet.add(acc, p)));
    const removesSet = yield* args.removes.pipe(
      Stream.runFold(HashSet.empty<RepoPath>(), (acc, p) => HashSet.add(acc, p))
    );

    const noOp = HashSet.size(addsSet) === 0 && HashSet.size(removesSet) === 0;
    const headOid = yield* readDirectRef(args.cfg.gitdir, MAIN_REF);
    if (noOp) return headOid;

    return yield* withIndexLock(
      args.cfg.gitdir,
      'remove'
    )(() =>
      Effect.gen(function* () {
        // Read current index.
        const current = yield* readIndex(args.cfg.gitdir).pipe(
          Effect.catchAll(
            (): Effect.Effect<{ readonly entries: readonly IndexEntry[] }> =>
              Effect.succeed({ entries: [] as readonly IndexEntry[] })
          )
        );
        const byPath = new Map<string, IndexEntry>();
        current.entries.forEach((e) => byPath.set(e.path, e));

        // Apply removes.
        HashSet.forEach(removesSet, (p) => byPath.delete(p));

        // Apply adds: hash workdir bytes, write loose blob, build IndexEntry.
        const addPaths = Array.from(HashSet.values(addsSet));
        yield* Effect.forEach(
          addPaths,
          (p) =>
            Effect.gen(function* () {
              const bytes = yield* readWorkdirBytes(args.cfg.dir, p);
              const oid = yield* writeLooseObject(args.cfg.gitdir, 'blob', bytes);
              const stub: IndexEntry = {
                path: p,
                oid,
                mode: 0o100644,
                stage: 0,
                assumeValid: false,
                stat: {
                  ctimeSec: 0,
                  ctimeNsec: 0,
                  mtimeSec: 0,
                  mtimeNsec: 0,
                  dev: 0,
                  ino: 0,
                  uid: 0,
                  gid: 0,
                  size: bytes.byteLength,
                },
              };
              byPath.set(p, stub);
            }),
          { concurrency: 'unbounded' }
        );

        // Build new index entries (sorted by path).
        const newEntries = Array.from(byPath.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

        // Build the tree from the new index entries.
        const treeMap = buildTreeMap(newEntries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid })));
        const treeOid = yield* newEntries.length === 0
          ? hashTreeFromMap(treeMap)
          : writeTreeFromMap(args.cfg.gitdir, treeMap);

        // Build the commit.
        const tsMs = yield* Clock.currentTimeMillis;
        const commitOid = yield* writeCommit(args.cfg.gitdir, {
          tree: treeOid,
          parent: headOid,
          author: args.author,
          tsSeconds: Math.floor(tsMs / 1000),
          message: args.message,
        });

        // Write the new index.
        const indexBytes = yield* writeIndexV2(newEntries);
        const fs = yield* FileSystem;
        const path = yield* Path;
        const indexPath = path.join(args.cfg.gitdir, 'index');
        yield* fs
          .writeFile(indexPath, indexBytes)
          .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(indexPath, cause))));

        // Advance refs/heads/main.
        yield* writeDirectRef(args.cfg.gitdir, MAIN_REF, commitOid);
        return commitOid;
      })
    );
  });
