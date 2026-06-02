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
import { SystemError } from '@effect/platform/Error';
import { FileSystem, type File as PlatformFile } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { nodeIgnores, readInfoExclude, walkAllRoots, type WalkResult } from './dirWalk';
import { WorkdirIoError } from './errors';
import { readIndex, type IndexEntry } from './indexV2';
import { hashBlob } from './objects';
import { type Oid, type RepoPath, RepoPath as RepoPathSchema, type StatusEntry } from './schemas';
import { streamHeadTree } from './trees';

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

/** Predicate: does `p` live under any of `roots`? Exact match or prefix-with-slash. */
const inRoots = (p: string, roots: readonly RepoPath[]): boolean => roots.some((r) => r === p || p.startsWith(`${r}/`));

/**
 * Stat-trust check: if the workdir stat (size + mtime ms) matches the index
 * entry, trust the recorded oid. Real-git's racy-stat behavior. Returns
 * `Some(oid)` on a hit, `None` on a miss (caller should rehash).
 */
const statTrustOid = Effect.fn('statTrustOid')(function* (abs: string, index: IndexEntry | undefined) {
  if (index === undefined || index.stat.size === 0) return Option.none<Oid>();
  const fs = yield* FileSystem;
  const stat = yield* fs.stat(abs).pipe(
    Effect.map(Option.some),
    Effect.catchAll(() => Effect.succeed(Option.none<PlatformFile.Info>()))
  );
  if (Option.isNone(stat)) return Option.none<Oid>();
  const mtimeMs = Option.getOrElse(stat.value.mtime, () => new Date(0)).getTime();
  const recordedMs = index.stat.mtimeSec * 1000 + Math.floor(index.stat.mtimeNsec / 1_000_000);
  return Number(stat.value.size) === index.stat.size && mtimeMs === recordedMs
    ? Option.some(index.oid)
    : Option.none<Oid>();
});

/** Hash workdir bytes for one path, or None if the file vanished mid-walk. */
const hashWorkdirOid = Effect.fn('hashWorkdirOid')(function* (abs: string) {
  const fs = yield* FileSystem;
  const bytes = yield* fs.readFile(abs).pipe(
    Effect.map((b) => Option.some(b)),
    Effect.catchAll((cause) =>
      isNotFound(cause)
        ? Effect.succeed(Option.none<Uint8Array>())
        : Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))
    )
  );
  return Option.isNone(bytes) ? Option.none<Oid>() : Option.some(yield* hashBlob(bytes.value));
});

/** Resolve the workdir oid for one path: stat-trust first, then rehash. */
const workdirOidFor = Effect.fn('workdirOidFor')(function* (dir: string, rel: string, index: IndexEntry | undefined) {
  const path = yield* Path;
  const abs = path.join(dir, rel);
  const trusted = yield* statTrustOid(abs, index);
  return Option.isSome(trusted) ? trusted : yield* hashWorkdirOid(abs);
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
  head: Oid | undefined,
  index: Oid | undefined,
  workdir: Oid | undefined,
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
        status: head === workdir && index === workdir ? 'unmodified' : 'modified',
      })
    ),
    Match.exhaustive
  );
};

/**
 * Pure cell evaluation for paths that DON'T need a workdir hash (untracked,
 * or tracked-but-deleted). We only need the workdir oid to distinguish
 * modified vs unmodified — every other branch in `collapse` ignores it.
 * Hashing every added file just to throw the oid away costs O(workdir-size)
 * fiber overhead on first-time `getStatus`.
 */
const cellPure = (
  rel: string,
  head: Oid | undefined,
  indexOid: Oid | undefined,
  inWorkdir: boolean,
  untracked: UntrackedClassification
): Option.Option<StatusEntry> => collapse(rel, head, indexOid, undefined, untracked, inWorkdir);

/**
 * Effectful cell evaluation for tracked-and-present-in-workdir paths.
 * These are the ones we genuinely have to hash — there's no other way to
 * know modified vs unmodified.
 */
const cellHashing = Effect.fn('cellHashing')(function* (
  cfg: { readonly dir: string },
  rel: string,
  head: Oid | undefined,
  index: IndexEntry | undefined,
  untracked: UntrackedClassification
) {
  const workdirOid = yield* workdirOidFor(cfg.dir, rel, index);
  return collapse(rel, head, index?.oid, Option.getOrUndefined(workdirOid), untracked, true);
});

/**
 * Shared evaluation core. Produces the sorted StatusEntry stream from
 * pre-resolved (head, index, workdir) inputs. Cold and warm both flow into
 * here; the only difference between them is HOW the `workdirSet` and
 * `untrackedClassification` were assembled.
 */
const evaluateMatrix = (
  cfg: { readonly dir: string; readonly roots: readonly RepoPath[] },
  headByPath: ReadonlyMap<string, Oid>,
  indexByPath: ReadonlyMap<string, IndexEntry>,
  workdirSet: ReadonlySet<string>,
  untracked: UntrackedClassification
) =>
  Effect.gen(function* () {
    const allPaths = Arr.sort(Order.string)(
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
      else pure.push(cellPure(p, head, indexEntry?.oid, inWd, untracked));
    }
    const hashed = yield* Effect.forEach(
      needsHash,
      (p) => cellHashing(cfg, p, headByPath.get(p), indexByPath.get(p), untracked),
      { concurrency: 256 }
    );
    return [...pure, ...hashed].flatMap((c) => (Option.isSome(c) ? [c.value] : []));
  });

/**
 * Build the (workdirSet, untrackedClassification) tuple from a fresh walk.
 * Used by cold and by the warm path's "stale slice" fallback.
 *
 * Tracked files are identified by membership in `indexByPath`. Walk-emitted
 * basenames not in the index are untracked; their `'added' | 'ignored'`
 * status comes from the per-dir chain `chainIgnores` evaluated at walk
 * time.
 */
const collectFromWalk = (
  walk: WalkResult,
  indexByPath: ReadonlyMap<string, IndexEntry>
): { readonly workdirSet: ReadonlySet<string>; readonly untracked: UntrackedClassification } => {
  const workdirSet = new Set<string>();
  const untracked = new Map<string, 'added' | 'ignored'>();
  // eslint-disable-next-line functional/no-loop-statements
  for (const node of walk.nodes) {
    // eslint-disable-next-line functional/no-loop-statements
    for (const name of node.snapshot.fileNames) {
      const rel = node.snapshot.dir === '' ? name : `${node.snapshot.dir}/${name}`;
      workdirSet.add(rel);
      if (!indexByPath.has(rel)) untracked.set(rel, nodeIgnores(node, rel) ? 'ignored' : 'added');
    }
  }
  return { workdirSet, untracked };
};

/**
 * Cold statusMatrix: walk the workdir per-directory (with nested
 * `.gitignore` evaluation), union with HEAD-tree paths and index entries,
 * collapse to StatusEntry.
 */
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
        yield* streamHeadTree(cfg.gitdir).pipe(
          Stream.map((p) => [p.path, p.oid] as const),
          Stream.runCollect,
          Effect.map((c): ReadonlyArray<readonly [string, Oid]> => Array.from(c))
        )
      );

      const walk = yield* walkAllRoots(
        { dir: cfg.dir, roots: cfg.roots, fdPermits: cfg.fdPermits ?? 256 },
        excludeContent
      );
      const fileRootSet = yield* collectBareFileRoots(cfg.dir, cfg.roots);
      const { workdirSet: walked, untracked } = collectFromWalk(walk, indexByPath);
      // Bare file roots don't show up via dir-walk; merge them in.
      const workdirSet = new Set([...walked, ...fileRootSet]);
      const untrackedAll = new Map(untracked);
      // eslint-disable-next-line functional/no-loop-statements
      for (const rel of fileRootSet) {
        if (!indexByPath.has(rel)) untrackedAll.set(rel, walk.isIgnoredAtRoot(rel) ? 'ignored' : 'added');
      }

      const cells = yield* evaluateMatrix(cfg, headByPath, indexByPath, workdirSet, untrackedAll);
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
    (rel) => {
      const eff = Effect.gen(function* () {
        const fs = yield* FileSystem;
        const path = yield* Path;
        const abs = path.join(dir, rel);
        const info = yield* fs.stat(abs).pipe(
          Effect.map(Option.some),
          Effect.catchAll((cause) =>
            isNotFound(cause)
              ? Effect.succeed(Option.none<PlatformFile.Info>())
              : Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))
          )
        );
        return Option.match(info, {
          onNone: () => Option.none<string>(),
          onSome: (i) => (i.type === 'Directory' ? Option.none<string>() : Option.some(rel as string)),
        });
      });
      return eff;
    },
    { concurrency: 'unbounded' }
  ).pipe(Effect.map((opts) => new Set(opts.flatMap((o) => (Option.isSome(o) ? [o.value] : [])))));

// Internals exposed to the warm path. Keep these as named exports rather
// than re-publishing through index.ts; the warm module is the only
// in-tree consumer.
export { collectBareFileRoots, evaluateMatrix, type UntrackedClassification };
