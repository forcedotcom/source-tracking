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
import { Path } from 'effect/Path';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as HashSet from 'effect/HashSet';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import { isNotUndefined } from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { nodeIgnores, readInfoExclude, walkAllRoots, type WalkResult } from './dirWalk.js';
import { readIndex, type IndexEntry } from './indexV2.js';
import { hashBlob } from './objects.js';
import { type Oid, type RepoPath, RepoPath as RepoPathSchema, type StatusEntry } from './schemas.js';
import { streamHeadTreeWithMode } from './trees.js';
import { GIT_FILE_MODE, gitModeFromStat, lstat, readWorkdirBytes } from './workdir.js';

type HeadFile = { readonly oid: Oid; readonly mode: number };

/** Predicate: does `p` live under any of `roots`? Exact match or prefix-with-slash. */
const inRoots =
  (roots: readonly RepoPath[]) =>
  (p: string): boolean =>
    roots.some((r) => r === p || p.startsWith(`${r}/`));

/** Hash workdir bytes for one path, or None if the file vanished mid-walk. */
const hashWorkdirOid = Effect.fnUntraced(function* (abs: string, mode: number) {
  return yield* readWorkdirBytes(abs, mode).pipe(
    Effect.map((b) => Option.some(b)),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<Uint8Array>())),
    Effect.flatMap((bytes) =>
      Option.match(bytes, {
        onNone: () => Effect.succeed(Option.none<Oid>()),
        onSome: (value) => hashBlob(value).pipe(Effect.map(Option.some)),
      })
    )
  );
});

/**
 * Untracked-classification table built once at walk time.
 *
 * Per-dir `.gitignore` chains are evaluated as the walk descends, so by the
 * time we collapse paths into `StatusEntry`s the question "is this path
 * ignored?" is already a Map lookup. `'added'` and `'ignored'` are the only
 * two valid resolutions for an untracked workdir file.
 */
type UntrackedClassification = HashMap.HashMap<string, 'added' | 'ignored'>;

/**
 * Collapse (head, index, workdir) → public StatusEntry per
 * STATUS-COLLAPSE.md. Returns Option.none when the path has no observable
 * state (head/index/workdir all empty).
 */
const collapse = (
  rawPath: string,
  head: HeadFile | undefined,
  index: IndexEntry | undefined,
  workdir: Oid | undefined,
  workdirMode: number | undefined,
  untracked: UntrackedClassification,
  hasWorkdir: boolean
): Option.Option<StatusEntry> => {
  const path = Schema.decodeUnknownSync(RepoPathSchema)(rawPath);
  const tracked = isNotUndefined(head) || isNotUndefined(index);
  return Match.value({ tracked, hasWorkdir }).pipe(
    Match.when({ tracked: false, hasWorkdir: false }, () => Option.none<StatusEntry>()),
    Match.when({ tracked: false, hasWorkdir: true }, () =>
      // Untracked files that the walk classified explicitly are 'added' or
      // 'ignored'. Anything not in the map (shouldn't happen with a fresh
      // walk; possible if a stale cache slice is in play) defaults to
      // 'added' — the safe-to-show classification.
      Option.some<StatusEntry>({
        path,
        status: Option.getOrElse(HashMap.get(untracked, rawPath), () => 'added'),
      })
    ),
    Match.when({ tracked: true, hasWorkdir: false }, () => Option.some<StatusEntry>({ path, status: 'deleted' })),
    Match.when({ tracked: true, hasWorkdir: true }, () =>
      Option.some<StatusEntry>({
        path,
        status: isNotUndefined(head)
          ? isNotUndefined(index) &&
            head.oid === workdir &&
            index.oid === workdir &&
            head.mode === workdirMode &&
            index.mode === workdirMode
            ? 'unmodified'
            : 'modified'
          : 'added',
      })
    ),
    Match.exhaustive
  );
};

/**
 * Pure cell evaluation for paths that DON'T need a workdir hash (untracked,
 * or tracked-but-deleted). Their status follows from path presence; only
 * tracked files present in the workdir need an oid comparison.
 * Hashing every added file just to throw the oid away costs O(workdir-size)
 * fiber overhead on first-time `getStatus`.
 */
const cellPure = (
  rel: string,
  head: HeadFile | undefined,
  index: IndexEntry | undefined,
  inWorkdir: boolean,
  untracked: UntrackedClassification
): Option.Option<StatusEntry> => collapse(rel, head, index, undefined, undefined, untracked, inWorkdir);

/**
 * Effectful cell evaluation for tracked-and-present-in-workdir paths.
 * These are the ones we genuinely have to hash — there's no other way to
 * know modified vs unmodified.
 */
const cellHashing = Effect.fnUntraced(function* (
  cfg: { readonly dir: string },
  rel: string,
  head: HeadFile | undefined,
  index: IndexEntry | undefined,
  workdirMode: number,
  untracked: UntrackedClassification
) {
  const path = yield* Path;
  return yield* hashWorkdirOid(path.join(cfg.dir, rel), workdirMode).pipe(
    Effect.map((workdirOid) =>
      collapse(rel, head, index, Option.getOrUndefined(workdirOid), workdirMode, untracked, true)
    )
  );
});

/**
 * Produce status entries from pre-resolved HEAD, index, and workdir paths.
 */
const evaluateMatrix = Effect.fn('evaluateMatrix')(function* ({
  cfg,
  headByPath,
  indexByPath,
  workdirSet,
  workdirModes,
  untracked,
}: {
  readonly cfg: { readonly dir: string; readonly roots: readonly RepoPath[]; readonly fdPermits?: number };
  readonly headByPath: HashMap.HashMap<string, HeadFile>;
  readonly indexByPath: HashMap.HashMap<string, IndexEntry>;
  readonly workdirSet: HashSet.HashSet<string>;
  readonly workdirModes: HashMap.HashMap<string, number>;
  readonly untracked: UntrackedClassification;
}) {
  const trackedPaths = HashSet.union(
    headByPath.pipe(HashMap.keys, HashSet.fromIterable),
    indexByPath.pipe(HashMap.keys, HashSet.fromIterable)
  );
  const allPaths = HashSet.union(trackedPaths, workdirSet).pipe(
    Arr.fromIterable,
    Arr.filter(inRoots(cfg.roots)),
    Arr.sort(Order.String)
  );

  // Hashing cohort is small (modified-or-unmodified tracked files); pure
  // cohort is the rest. Partition once so the pure majority doesn't spawn
  // fibers or require mutable accumulator arrays.
  const [needsHash, pure] = Arr.partition(allPaths, (p) => {
    const head = Option.getOrUndefined(HashMap.get(headByPath, p));
    const indexEntry = Option.getOrUndefined(HashMap.get(indexByPath, p));
    const tracked = isNotUndefined(head) || isNotUndefined(indexEntry);
    const inWd = HashSet.has(workdirSet, p);
    return tracked && inWd ? Result.succeed(p) : Result.fail(cellPure(p, head, indexEntry, inWd, untracked));
  });
  yield* Effect.annotateCurrentSpan({ pathCount: allPaths.length, hashedFileCount: needsHash.length });
  return yield* Effect.forEach(
    needsHash,
    (p) =>
      cellHashing(
        cfg,
        p,
        Option.getOrUndefined(HashMap.get(headByPath, p)),
        Option.getOrUndefined(HashMap.get(indexByPath, p)),
        Option.getOrUndefined(HashMap.get(workdirModes, p)) ?? GIT_FILE_MODE,
        untracked
      ),
    { concurrency: cfg.fdPermits ?? 256 }
  ).pipe(Effect.map((hashed) => [...pure, ...hashed].flatMap((c) => (Option.isSome(c) ? [c.value] : []))));
});

/**
 * Build the workdir indexes from a fresh walk.
 *
 * Tracked files are identified by membership in `indexByPath`. Walk-emitted
 * basenames not in the index are untracked; their `'added' | 'ignored'`
 * status comes from the per-dir chain `chainIgnores` evaluated at walk
 * time.
 */
const collectFromWalk = (
  walk: WalkResult,
  indexByPath: HashMap.HashMap<string, IndexEntry>
): {
  readonly workdirSet: HashSet.HashSet<string>;
  readonly workdirModes: HashMap.HashMap<string, number>;
  readonly untracked: UntrackedClassification;
} =>
  walk.nodes.reduce(
    (walked, node) =>
      node.snapshot.fileNames.reduce((state, name) => {
        const rel = node.snapshot.dir === '' ? name : `${node.snapshot.dir}/${name}`;
        const workdirSet = HashSet.add(state.workdirSet, rel);
        const workdirModes = HashMap.set(state.workdirModes, rel, node.snapshot.fileModes.get(name) ?? GIT_FILE_MODE);
        const untracked = HashMap.has(indexByPath, rel)
          ? state.untracked
          : HashMap.set(state.untracked, rel, nodeIgnores(node, rel) ? 'ignored' : 'added');
        return { workdirSet, workdirModes, untracked };
      }, walked),
    {
      workdirSet: HashSet.empty<string>(),
      workdirModes: HashMap.empty<string, number>(),
      untracked: HashMap.empty<string, 'added' | 'ignored'>(),
    }
  );

/**
 * Cold statusMatrix: walk the workdir per-directory (with nested
 * `.gitignore` evaluation), union with HEAD-tree paths and index entries,
 * collapse to StatusEntry.
 */
/** @internal */
export const cold = (cfg: {
  readonly dir: string;
  readonly gitdir: string;
  readonly roots: readonly RepoPath[];
  readonly fdPermits?: number;
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const excludeContent = yield* readInfoExclude(cfg.gitdir);
      const idx = yield* readIndex(cfg.gitdir);
      const indexByPath = HashMap.fromIterable(
        idx.entries.map((e) => [e.path, e] satisfies readonly [string, IndexEntry])
      );

      const headByPath = HashMap.fromIterable(
        yield* streamHeadTreeWithMode(cfg.gitdir).pipe(
          Stream.map(
            (entry) => [entry.path, { oid: entry.oid, mode: entry.mode }] satisfies readonly [string, HeadFile]
          ),
          Stream.runCollect
        )
      );

      const walk = yield* walkAllRoots(
        { dir: cfg.dir, roots: cfg.roots, fdPermits: cfg.fdPermits ?? 256 },
        excludeContent
      );
      const { workdirSet: fileRootPaths, workdirModes: fileRootModes } = yield* collectBareFileRoots(
        cfg.dir,
        cfg.roots
      );
      const { workdirSet: walked, workdirModes: walkedModes, untracked } = collectFromWalk(walk, indexByPath);
      // Bare file roots don't show up via dir-walk; merge them in.
      const workdirSet = HashSet.union(walked, fileRootPaths);
      const workdirModes = HashMap.union(walkedModes, fileRootModes);
      const bareFileUntracked = HashMap.fromIterable(
        fileRootPaths.pipe(
          HashSet.filter((rel) => !HashMap.has(indexByPath, rel)),
          HashSet.map(
            (rel) =>
              [rel, walk.isIgnoredAtRoot(rel) ? 'ignored' : 'added'] satisfies readonly [string, 'added' | 'ignored']
          )
        )
      );
      const untrackedAll = HashMap.union(untracked, bareFileUntracked);

      return yield* evaluateMatrix({
        cfg,
        headByPath,
        indexByPath,
        workdirSet,
        workdirModes,
        untracked: untrackedAll,
      }).pipe(Effect.map(Stream.fromIterable));
    })
  );

/**
 * For roots that point at single files (not directories), stat them and
 * return the relative paths that exist as non-directory files. Mirrors the
 * old `walkOneRoot`'s "if the root is a file, emit it as one entry"
 * behavior — necessary for tests that pass a file-list as `roots`.
 */
const collectBareFileRoots = (dir: string, roots: readonly RepoPath[]) =>
  Effect.forEach(
    roots,
    (rel) =>
      Effect.gen(function* () {
        const path = yield* Path;
        const abs = path.join(dir, rel);
        return yield* lstat(abs).pipe(
          Effect.map((entry) =>
            entry.isDirectory()
              ? Option.none<readonly [string, number]>()
              : Option.some([rel, gitModeFromStat(entry)] satisfies readonly [RepoPath, number])
          ),
          Effect.catchReason('PlatformError', 'NotFound', () =>
            Effect.succeed(Option.none<readonly [string, number]>())
          )
        );
      }),
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map((entries) => entries.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))),
    Effect.map((entries) => ({
      workdirSet: HashSet.fromIterable(entries.map(([file]) => file)),
      workdirModes: HashMap.fromIterable(entries),
    }))
  );
