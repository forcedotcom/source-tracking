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
import type { Stats } from 'node:fs';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { nodeIgnores, readInfoExclude, walkAllRoots, type WalkResult } from './dirWalk.js';
import { WorkdirIoError } from './errors.js';
import { readIndex, type IndexEntry } from './indexV2.js';
import { hashBlob } from './objects.js';
import { type Oid, type RepoPath, RepoPath as RepoPathSchema, type StatusEntry } from './schemas.js';
import { streamHeadTreeWithMode } from './trees.js';
import { GIT_FILE_MODE, gitModeFromStat, isSymlinkMode, lstat, normalizeGitSymlinkTarget } from './workdir.js';

const TEXT = new TextEncoder();
type HeadFile = { readonly oid: Oid; readonly mode: number };

/** Predicate: does `p` live under any of `roots`? Exact match or prefix-with-slash. */
const inRoots = (p: string, roots: readonly RepoPath[]): boolean => roots.some((r) => r === p || p.startsWith(`${r}/`));

/** Hash workdir bytes for one path, or None if the file vanished mid-walk. */
const hashWorkdirOid = Effect.fn('hashWorkdirOid')(function* (abs: string, mode: number) {
  const fs = yield* FileSystem;
  const content = isSymlinkMode(mode)
    ? fs.readLink(abs).pipe(Effect.map((target) => TEXT.encode(normalizeGitSymlinkTarget(target))))
    : fs.readFile(abs);
  const bytes = yield* content.pipe(
    Effect.map((b) => Option.some(b)),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<Uint8Array>())),
    Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(abs, cause)))
  );
  return Option.isNone(bytes) ? Option.none<Oid>() : Option.some(yield* hashBlob(bytes.value));
});

/**
 * Untracked-classification table built once at walk time.
 *
 * Per-dir `.gitignore` chains are evaluated as the walk descends, so by the
 * time we collapse paths into `StatusEntry`s the question "is this path
 * ignored?" is already a Map lookup. `'added'` and `'ignored'` are the only
 * two valid resolutions for an untracked workdir file.
 */
type UntrackedClassification = ReadonlyMap<string, 'added' | 'ignored'>;

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
  const tracked = head !== undefined || index !== undefined;
  return Match.value({ tracked, hasWorkdir }).pipe(
    Match.when({ tracked: false, hasWorkdir: false }, () => Option.none<StatusEntry>()),
    Match.when({ tracked: false, hasWorkdir: true }, () =>
      // Untracked files that the walk classified explicitly are 'added' or
      // 'ignored'. Anything not in the map (shouldn't happen with a fresh
      // walk; possible if a stale cache slice is in play) defaults to
      // 'added' — the safe-to-show classification.
      Option.some<StatusEntry>({ path, status: untracked.get(rawPath) ?? 'added' })
    ),
    Match.when({ tracked: true, hasWorkdir: false }, () => Option.some<StatusEntry>({ path, status: 'deleted' })),
    Match.when({ tracked: true, hasWorkdir: true }, () =>
      Option.some<StatusEntry>({
        path,
        status:
          head !== undefined &&
          index !== undefined &&
          head.oid === workdir &&
          index.oid === workdir &&
          head.mode === workdirMode &&
          index.mode === workdirMode
            ? 'unmodified'
            : 'modified',
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
const cellHashing = Effect.fn('cellHashing')(function* (
  cfg: { readonly dir: string },
  rel: string,
  head: HeadFile | undefined,
  index: IndexEntry | undefined,
  workdirMode: number,
  untracked: UntrackedClassification
) {
  const path = yield* Path;
  const workdirOid = yield* hashWorkdirOid(path.join(cfg.dir, rel), workdirMode);
  return collapse(rel, head, index, Option.getOrUndefined(workdirOid), workdirMode, untracked, true);
});

/**
 * Produce sorted status entries from pre-resolved HEAD, index, and workdir
 * paths.
 */
const evaluateMatrix = (
  cfg: { readonly dir: string; readonly roots: readonly RepoPath[] },
  headByPath: ReadonlyMap<string, HeadFile>,
  indexByPath: ReadonlyMap<string, IndexEntry>,
  workdirSet: ReadonlySet<string>,
  workdirModes: ReadonlyMap<string, number>,
  untracked: UntrackedClassification
) =>
  Effect.gen(function* () {
    const allPaths = Arr.sort(Order.String)(
      Arr.fromIterable(new Set([...headByPath.keys(), ...indexByPath.keys(), ...workdirSet])).filter((p) =>
        inRoots(p, cfg.roots)
      )
    );

    // Partition: paths that need a workdir hash vs paths that don't.
    // Hashing cohort is small (modified-or-unmodified tracked files); pure
    // cohort is the rest. Doing the pure majority synchronously avoids
    // spawning N fibers for pure-CPU work.
    const pure: Array<Option.Option<StatusEntry>> = [];
    const needsHash: string[] = [];
    // eslint-disable-next-line functional/no-loop-statements
    for (const p of allPaths) {
      const head = headByPath.get(p);
      const indexEntry = indexByPath.get(p);
      const tracked = head !== undefined || indexEntry !== undefined;
      const inWd = workdirSet.has(p);
      if (tracked && inWd) needsHash.push(p);
      else pure.push(cellPure(p, head, indexEntry, inWd, untracked));
    }
    const hashed = yield* Effect.forEach(
      needsHash,
      (p) =>
        cellHashing(cfg, p, headByPath.get(p), indexByPath.get(p), workdirModes.get(p) ?? GIT_FILE_MODE, untracked),
      { concurrency: 256 }
    );
    return Arr.sort(Order.mapInput(Order.String, (entry: StatusEntry) => entry.path))(
      [...pure, ...hashed].flatMap((c) => (Option.isSome(c) ? [c.value] : []))
    );
  });

/**
 * Build the (workdirSet, untrackedClassification) tuple from a fresh walk.
 *
 * Tracked files are identified by membership in `indexByPath`. Walk-emitted
 * basenames not in the index are untracked; their `'added' | 'ignored'`
 * status comes from the per-dir chain `chainIgnores` evaluated at walk
 * time.
 */
const collectFromWalk = (
  walk: WalkResult,
  indexByPath: ReadonlyMap<string, IndexEntry>
): {
  readonly workdirSet: ReadonlySet<string>;
  readonly workdirModes: ReadonlyMap<string, number>;
  readonly untracked: UntrackedClassification;
} => {
  const workdirSet = new Set<string>();
  const workdirModes = new Map<string, number>();
  const untracked = new Map<string, 'added' | 'ignored'>();
  // eslint-disable-next-line functional/no-loop-statements
  for (const node of walk.nodes) {
    // eslint-disable-next-line functional/no-loop-statements
    for (const name of node.snapshot.fileNames) {
      const rel = node.snapshot.dir === '' ? name : `${node.snapshot.dir}/${name}`;
      workdirSet.add(rel);
      workdirModes.set(rel, node.snapshot.fileModes.get(name) ?? GIT_FILE_MODE);
      if (!indexByPath.has(rel)) untracked.set(rel, nodeIgnores(node, rel) ? 'ignored' : 'added');
    }
  }
  return { workdirSet, workdirModes, untracked };
};

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
      const indexByPath = new Map(idx.entries.map((e) => [e.path, e] as const));

      const headByPath = new Map(
        yield* streamHeadTreeWithMode(cfg.gitdir).pipe(
          Stream.map((entry) => [entry.path, { oid: entry.oid, mode: entry.mode }] as const),
          Stream.runCollect,
          Effect.map((c): ReadonlyArray<readonly [string, HeadFile]> => Array.from(c))
        )
      );

      const walk = yield* walkAllRoots(
        { dir: cfg.dir, roots: cfg.roots, fdPermits: cfg.fdPermits ?? 256 },
        excludeContent
      );
      const fileRoots = yield* collectBareFileRoots(cfg.dir, cfg.roots);
      const { workdirSet: walked, workdirModes: walkedModes, untracked } = collectFromWalk(walk, indexByPath);
      // Bare file roots don't show up via dir-walk; merge them in.
      const workdirSet = new Set([...walked, ...fileRoots.paths]);
      const workdirModes = new Map([...walkedModes, ...fileRoots.modes]);
      const untrackedAll = new Map(untracked);
      // eslint-disable-next-line functional/no-loop-statements
      for (const rel of fileRoots.paths) {
        if (!indexByPath.has(rel)) untrackedAll.set(rel, walk.isIgnoredAtRoot(rel) ? 'ignored' : 'added');
      }

      const cells = yield* evaluateMatrix(cfg, headByPath, indexByPath, workdirSet, workdirModes, untrackedAll);
      return Stream.fromIterable(cells);
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
        const info = yield* lstat(abs).pipe(
          Effect.map(Option.some),
          Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<Stats>())),
          Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(abs, cause)))
        );
        return Option.match(info, {
          onNone: () => Option.none<readonly [string, number]>(),
          onSome: (entry) =>
            entry.isDirectory()
              ? Option.none<readonly [string, number]>()
              : Option.some([rel, gitModeFromStat(entry)] as const),
        });
      }),
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map((entries) => entries.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))),
    Effect.map((entries) => ({ paths: new Set(entries.map(([file]) => file)), modes: new Map(entries) }))
  );
