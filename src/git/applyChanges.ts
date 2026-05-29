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
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as HashSet from 'effect/HashSet';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { WorkdirIoError } from './errors';
import { readIndex, type IndexEntry } from './indexV2';
import { withIndexLock } from './lock';
import { writeLooseObject } from './objects';
import { readDirectRef, writeDirectRef } from './refs';
import { type Author, type CommitOid, RefName, type RepoPath } from './schemas';
import { buildTreeMap, hashTreeFromMap, writeCommit, writeIndexV2, writeTreeFromMap } from './writers';

const MAIN_REF: RefName = Schema.decodeUnknownSync(RefName)('refs/heads/main');

const readWorkdirBytes = Effect.fn('readWorkdirBytes')(function* (dir: string, rel: RepoPath) {
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

const stageAdd = Effect.fn('stageAdd')(function* (cfg: ApplyArgs['cfg'], p: RepoPath) {
  const bytes = yield* readWorkdirBytes(cfg.dir, p);
  const oid = yield* writeLooseObject(cfg.gitdir, 'blob', bytes);
  return [
    p,
    {
      path: p,
      oid,
      mode: 0o10_0644,
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
    } satisfies IndexEntry,
  ] as const;
});

const buildAndCommit = Effect.fn('buildAndCommit')(function* (
  args: ApplyArgs,
  headOid: CommitOid,
  addsSet: HashSet.HashSet<RepoPath>,
  removesSet: HashSet.HashSet<RepoPath>
) {
  // Read current index (empty if absent — first applyChanges after init).
  const current = yield* readIndex(args.cfg.gitdir).pipe(
    Effect.catchAll(() => Effect.succeed({ entries: [] as readonly IndexEntry[] }))
  );

  // Stage adds in parallel into [path, IndexEntry] pairs.
  const stagedPairs = yield* Effect.forEach(Array.from(HashSet.values(addsSet)), (p) => stageAdd(args.cfg, p), {
    concurrency: 'unbounded',
  });

  // current entries → HashMap, drop removes, merge in adds.
  const fromCurrent = HashMap.fromIterable<string, IndexEntry>(current.entries.map((e) => [e.path, e] as const));
  const afterRemoves = HashSet.reduce(removesSet, fromCurrent, (acc, p) => HashMap.remove(acc, p));
  const finalMap = stagedPairs.reduce((acc, [p, entry]) => HashMap.set(acc, p, entry), afterRemoves);

  // Materialize the sorted entry list for tree/index serialization.
  const newEntries = Array.from(HashMap.values(finalMap)).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );

  // Build the tree from the new index entries.
  const treeMap = buildTreeMap(newEntries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid })));
  const treeOid = yield* newEntries.length === 0
    ? hashTreeFromMap(treeMap)
    : writeTreeFromMap(args.cfg.gitdir, treeMap);

  // Build the commit.
  const tsMs = yield* Clock.currentTimeMillis;
  const commitOid = yield* writeCommit(args.cfg.gitdir, {
    tree: treeOid,
    parent: Option.some(headOid),
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
});

/**
 * applyChanges = stage adds, drop removes, write tree+commit, advance HEAD
 * branch ref. Pipes through withIndexLock so concurrent writers serialize.
 *
 * Empty-streams short-circuit per the spec: returns the current HEAD oid
 * without creating a new commit.
 */
export const applyChanges = Effect.fn('applyChanges')(function* (args: ApplyArgs) {
  // Dedup adds/removes via HashSet<RepoPath> per the spec.
  const addsSet = yield* args.adds.pipe(Stream.runFold(HashSet.empty<RepoPath>(), (acc, p) => HashSet.add(acc, p)));
  const removesSet = yield* args.removes.pipe(
    Stream.runFold(HashSet.empty<RepoPath>(), (acc, p) => HashSet.add(acc, p))
  );

  const noOp = HashSet.size(addsSet) === 0 && HashSet.size(removesSet) === 0;
  const headOid = yield* readDirectRef(args.cfg.gitdir, MAIN_REF);
  if (noOp) return headOid;

  return yield* buildAndCommit(args, headOid, addsSet, removesSet).pipe(withIndexLock(args.cfg.gitdir));
});
