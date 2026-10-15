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
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as HashSet from 'effect/HashSet';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { WorkdirIoError } from './errors.js';
import { readIndex, type IndexEntry } from './indexV2.js';
import { withIndexLockCtx } from './lock.js';
import { writeLooseObject } from './objects.js';
import { readDirectRef, writeDirectRef } from './refs.js';
import { type Author, type CommitOid, RefName, type RepoPath } from './schemas.js';
import { buildTreeMap, hashTreeFromMap, writeCommit, writeIndexV2, writeTreeFromMap } from './writers.js';
import { gitModeFromStat, lstat } from './workdir.js';

const MAIN_REF: RefName = Schema.decodeUnknownSync(RefName)('refs/heads/main');
const TEXT = new TextEncoder();

// fnUntraced: callsite is per-file in applyChanges; we get the aggregate
// from the count annotation on the parent span instead of N child spans.
const readWorkdirBytes = Effect.fnUntraced(function* (dir: string, rel: RepoPath) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const abs = path.join(dir, rel);
  return yield* fs
    .readFile(abs)
    .pipe(Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))));
});

export type ApplyArgs = {
  readonly cfg: { readonly dir: string; readonly gitdir: string };
  readonly adds: Stream.Stream<RepoPath>;
  readonly removes: Stream.Stream<RepoPath>;
  readonly message: string;
  readonly author: Author;
  /**
   * Cap on concurrent stageAdd fibers. Each stageAdd opens 1 read fd
   * (workdir blob) plus up to 2 write fds (loose-object dir mkdir + file
   * write). Default 256 keeps us well under most Linux/Mac soft ulimits
   * (1024) and Windows fd ceiling (~2048). Iso-git's batched
   * `MAX_FILE_ADD` defaulted to 15000 because iso held all fds open through
   * the whole batch; lite releases per-add so a much lower cap is fine.
   */
  readonly addConcurrency?: number;
};

// fnUntraced: per-file. applyChanges parent span carries the aggregate count.
//
// Record lstat fields in the index entry. Symlinks are stored as their target
// text with Git's symlink mode; regular files store their bytes as usual.
const stageAdd = Effect.fnUntraced(function* (cfg: ApplyArgs['cfg'], p: RepoPath) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const abs = path.join(cfg.dir, p);
  const info = yield* lstat(abs).pipe(
    Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(abs, cause)))
  );
  const bytes = info.isSymbolicLink()
    ? yield* fs.readLink(abs).pipe(
        Effect.map((target) => TEXT.encode(target)),
        Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(abs, cause)))
      )
    : yield* readWorkdirBytes(cfg.dir, p);
  const oid = yield* writeLooseObject(cfg.gitdir, 'blob', bytes);
  const mtimeMs = info.mtimeMs;
  const ctimeMs = info.ctimeMs;
  return [
    p,
    {
      path: p,
      oid,
      mode: gitModeFromStat(info),
      stage: 0,
      assumeValid: false,
      stat: {
        ctimeSec: Math.floor(ctimeMs / 1000),
        ctimeNsec: (ctimeMs % 1000) * 1_000_000,
        mtimeSec: Math.floor(mtimeMs / 1000),
        mtimeNsec: (mtimeMs % 1000) * 1_000_000,
        // dev/ino are encoded as u32 on disk; truncate the high bits on
        // platforms where they exceed 2^32.
        dev: info.dev >>> 0,
        ino: info.ino >>> 0,
        uid: 0,
        gid: 0,
        size: bytes.byteLength,
      },
    } satisfies IndexEntry,
  ] as const;
});

/**
 * Compose the next index entry set from current + adds/removes. Stays in
 * HashMap natively: removeMany drops keys, union merges adds; the final
 * HashSet is built directly from the merged map's values. writeIndexV2
 * owns the bytewise sort, so no intermediate array is needed here.
 */
const nextEntries = (
  current: HashMap.HashMap<string, IndexEntry>,
  removes: HashSet.HashSet<RepoPath>,
  adds: HashMap.HashMap<string, IndexEntry>
): HashSet.HashSet<IndexEntry> =>
  HashMap.removeMany(current, removes).pipe(HashMap.union(adds), HashMap.values, HashSet.fromIterable);

/**
 * Cache-class extensions summarize index/tree state; any non-empty
 * applyChanges may invalidate them, so we drop them on commit. This also
 * drops stale UNTR extensions read from existing indexes. Stable extensions
 * (e.g. `link`, `sdir`) pass through verbatim.
 *
 * - `TREE`: cached subtree oids — stale when any tree shape changes.
 * - `REUC`: resolve-undo — bound to a merge state we don't model.
 * - `UNTR`: untracked-files cache — stale when a directory mutates.
 */
const CACHE_EXTENSION_SIGNATURES: ReadonlySet<string> = new Set(['TREE', 'REUC', 'UNTR']);
type IndexExtension = { readonly signature: string; readonly payload: Uint8Array };
const isStableExtension = (ext: IndexExtension): boolean => !CACHE_EXTENSION_SIGNATURES.has(ext.signature);

const writeIndex = Effect.fn('writeIndex')(function* (
  indexPath: string,
  entries: HashSet.HashSet<IndexEntry>,
  extensions: readonly IndexExtension[]
) {
  const fs = yield* FileSystem;
  const bytes = yield* writeIndexV2(entries, extensions);
  yield* fs
    .writeFile(indexPath, bytes)
    .pipe(Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(indexPath, cause))));
});

const writeTreeForEntries = (gitdir: string, entries: HashSet.HashSet<IndexEntry>) => {
  const treeMap = buildTreeMap(HashSet.map(entries, (e) => ({ path: e.path, mode: e.mode, oid: e.oid })));
  return HashSet.size(entries) === 0 ? hashTreeFromMap(treeMap) : writeTreeFromMap(gitdir, treeMap);
};

const DEFAULT_ADD_CONCURRENCY = 256;

const buildAndCommit = Effect.fn('buildAndCommit')(function* (
  args: ApplyArgs,
  headOid: CommitOid,
  addsSet: HashSet.HashSet<RepoPath>,
  removesSet: HashSet.HashSet<RepoPath>,
  indexLockPath: string
) {
  // Aggregate counts on the parent span. The per-file spans on stageAdd /
  // writeLooseObject / hashLooseObject / readWorkdirBytes are intentionally
  // suppressed (Effect.fnUntraced); the totals live here instead.
  yield* Effect.annotateCurrentSpan({
    addCount: HashSet.size(addsSet),
    removeCount: HashSet.size(removesSet),
  });
  // Read current index (empty if absent — first applyChanges after init),
  // and stage every add in parallel. Both are independent of each other,
  // and both produce HashMaps so we never need an intermediate array.
  // The added side is a Stream<[path, IndexEntry]>: stageAdd runs at
  // bounded concurrency and entries fold into a HashMap as they arrive,
  // so we never hold all 200k staged tuples in memory at once.
  const [parsed, addsMap] = yield* Effect.all(
    [
      readIndex(args.cfg.gitdir),
      Stream.fromIterable(addsSet).pipe(
        Stream.mapEffect((p) => stageAdd(args.cfg, p), {
          concurrency: args.addConcurrency ?? DEFAULT_ADD_CONCURRENCY,
        }),
        Stream.runFold(
          () => HashMap.empty<string, IndexEntry>(),
          (acc, [p, e]) => HashMap.set(acc, p, e)
        )
      ),
    ],
    { concurrency: 'unbounded' }
  );
  const currentMap = HashMap.fromIterable(parsed.entries.map((e) => [e.path, e] as const));
  // Drop cache-class extensions — they summarize state this commit changed.
  // Stable extensions pass through.
  const carriedExtensions = parsed.extensions.filter(isStableExtension);

  const entries = nextEntries(currentMap, removesSet, addsMap);
  const commitOid = yield* writeCommit(args.cfg.gitdir, {
    tree: yield* writeTreeForEntries(args.cfg.gitdir, entries),
    parent: Option.some(headOid),
    author: args.author,
    tsSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
    message: args.message,
  });
  yield* writeIndex(indexLockPath, entries, carriedExtensions);
  yield* writeDirectRef(args.cfg.gitdir, MAIN_REF, commitOid);
  return commitOid;
});

/**
 * applyChanges = stage adds, drop removes, write tree+commit, advance HEAD
 * branch ref. Writes the index through `index.lock` and atomically renames it
 * into place so concurrent writers serialize and readers never see a partial index.
 *
 * Empty-streams short-circuit per the spec: returns the current HEAD oid
 * without creating a new commit.
 */
export const applyChanges = Effect.fn('applyChanges')(function* (args: ApplyArgs) {
  // Dedup adds/removes via HashSet<RepoPath> per the spec. Drain both streams
  // before taking the index lock so the critical section only covers Git state.
  const collectSet = <A>(s: Stream.Stream<A>) =>
    s.pipe(
      Stream.runFold(
        () => HashSet.empty<A>(),
        (acc, p) => HashSet.add(acc, p)
      )
    );
  const [addsSet, removesSet] = yield* Effect.all([collectSet(args.adds), collectSet(args.removes)], {
    concurrency: 'unbounded',
  });

  if (HashSet.size(addsSet) === 0 && HashSet.size(removesSet) === 0) {
    return yield* readDirectRef(args.cfg.gitdir, MAIN_REF);
  }

  return yield* withIndexLockCtx(
    args.cfg.gitdir,
    'rename-to-index'
  )(({ lockPath }) =>
    Effect.gen(function* () {
      // Read HEAD only after acquiring the writer lock so concurrent commits
      // use the previous writer's commit as their parent.
      const headOid = yield* readDirectRef(args.cfg.gitdir, MAIN_REF);
      return yield* buildAndCommit(args, headOid, addsSet, removesSet, lockPath);
    })
  );
});
