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
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { WorkdirIoError } from './errors';
import { readIndex, type IndexEntry } from './indexV2';
import { hashBlob } from './objects';
import { type Oid, type RepoPath, RepoPath as RepoPathSchema, type StatusEntry } from './schemas';
import { streamHeadTree } from './trees';

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

/** Build the `ignore` matcher from `.git/info/exclude`. Empty if absent. */
const loadIgnoreMatcher = Effect.fn('loadIgnoreMatcher')(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const file = path.join(gitdir, 'info', 'exclude');
  const content = yield* fs
    .readFileString(file)
    .pipe(
      Effect.catchAll((cause) =>
        isNotFound(cause) ? Effect.succeed('') : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
      )
    );
  return ignore().add(content);
});

/** Walk one root: stat once, then either emit the file or recurse into the directory. */
const walkOneRoot = Effect.fn('walkOneRoot')(function* (dir: string, rootRel: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const absRoot = path.join(dir, rootRel);
  const rootStat = yield* fs.stat(absRoot).pipe(
    Effect.map((s) => ({ kind: 'present' as const, type: s.type })),
    Effect.catchAll((cause) =>
      isNotFound(cause)
        ? Effect.succeed({ kind: 'absent' as const })
        : Effect.fail(WorkdirIoError.fromPlatformError(absRoot, cause))
    )
  );
  if (rootStat.kind === 'absent') return [];
  if (rootStat.type !== 'Directory') return [rootRel];

  const entries: readonly string[] = yield* fs
    .readDirectory(absRoot, { recursive: true })
    .pipe(
      Effect.catchAll((cause) =>
        isNotFound(cause) ? Effect.succeed([]) : Effect.fail(WorkdirIoError.fromPlatformError(absRoot, cause))
      )
    );
  const relPaths = entries.map((e) => `${rootRel}/${e.replaceAll('\\', '/')}`);
  // ENOENT mid-walk: silently drop. Other errors surface. Concurrency
  // capped (was 'unbounded') because 200k parallel fibers cost more in
  // fiber overhead than the OS can usefully service against ~256 fd
  // permits — and an unbounded forEach pegged the event loop hard
  // (elP99 ~4.7s on the 200k-file scale test).
  const stats = yield* Effect.forEach(
    relPaths,
    (rel) =>
      fs.stat(path.join(dir, rel)).pipe(
        Effect.map((info) => Option.some({ rel, type: info.type })),
        Effect.catchAll((cause) =>
          isNotFound(cause)
            ? Effect.succeed(Option.none<{ rel: string; type: string }>())
            : Effect.fail(WorkdirIoError.fromPlatformError(rel, cause))
        )
      ),
    { concurrency: 256 }
  );
  return stats.flatMap((opt) =>
    Option.match(opt, {
      onNone: (): readonly string[] => [],
      onSome: (s): readonly string[] => (s.type !== 'Directory' ? [s.rel] : []),
    })
  );
});

/**
 * Walk all files under `dir/<root>` for each root in cfg.roots. Posix paths
 * relative to `dir`. ENOENT mid-walk silently dropped.
 */
const collectWorkdirFiles = (dir: string, roots: readonly RepoPath[]) =>
  Effect.forEach(roots, (r) => walkOneRoot(dir, r), { concurrency: 'unbounded' }).pipe(Effect.map((p) => p.flat()));

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
 * Collapse (head, index, workdir) → public StatusEntry per
 * STATUS-COLLAPSE.md. Returns Option.none when the path has no observable
 * state (head/index/workdir all empty).
 */
const collapse = (
  rawPath: string,
  head: Oid | undefined,
  index: Oid | undefined,
  workdir: Oid | undefined,
  matcher: Ignore,
  hasWorkdir: boolean
): Option.Option<StatusEntry> => {
  const path = Schema.decodeUnknownSync(RepoPathSchema)(rawPath);
  const tracked = head !== undefined || index !== undefined;
  return Match.value({ tracked, hasWorkdir }).pipe(
    Match.when({ tracked: false, hasWorkdir: false }, () => Option.none<StatusEntry>()),
    Match.when({ tracked: false, hasWorkdir: true }, () =>
      Option.some<StatusEntry>({ path, status: matcher.ignores(rawPath) ? 'ignored' : 'added' })
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
  matcher: Ignore
): Option.Option<StatusEntry> => collapse(rel, head, indexOid, undefined, matcher, inWorkdir);

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
  matcher: Ignore
) {
  const workdirOid = yield* workdirOidFor(cfg.dir, rel, index);
  return collapse(rel, head, index?.oid, Option.getOrUndefined(workdirOid), matcher, true);
});

/**
 * Cold statusMatrix: union of HEAD-tree paths, index entries, and workdir
 * files; emit a StatusEntry per path per the collapse table.
 *
 * Phase 8 has no UNTR; phase 11 layers a warm path on top.
 */
export const cold = (cfg: { readonly dir: string; readonly gitdir: string; readonly roots: readonly RepoPath[] }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const matcher = yield* loadIgnoreMatcher(cfg.gitdir);
      const idx = yield* readIndex(cfg.gitdir);
      const indexByPath = new Map(idx.entries.map((e) => [e.path, e] as const));

      const headByPath = new Map(
        yield* streamHeadTree(cfg.gitdir).pipe(
          Stream.map((p) => [p.path, p.oid] as const),
          Stream.runCollect,
          Effect.map((c): ReadonlyArray<readonly [string, Oid]> => Array.from(c))
        )
      );

      const workdirFiles = yield* collectWorkdirFiles(cfg.dir, cfg.roots);
      const workdirSet = new Set(workdirFiles);

      // Union all keys, filter to roots, sort once.
      const allPaths = Arr.sort(Order.string)(
        Arr.fromIterable(new Set([...headByPath.keys(), ...indexByPath.keys(), ...workdirFiles])).filter((p) =>
          inRoots(p, cfg.roots)
        )
      );

      // Partition: paths that need a workdir hash vs paths that don't.
      // The hashing cohort is usually tiny (only modified-or-unmodified
      // tracked files); the pure cohort is the rest. Doing the pure
      // majority synchronously avoids spawning N fibers for pure-CPU work.
      const pure: Array<Option.Option<StatusEntry>> = [];
      const needsHash: string[] = [];
      // eslint-disable-next-line functional/no-loop-statements
      for (const p of allPaths) {
        const head = headByPath.get(p);
        const indexEntry = indexByPath.get(p);
        const tracked = head !== undefined || indexEntry !== undefined;
        const inWd = workdirSet.has(p);
        if (tracked && inWd) needsHash.push(p);
        else pure.push(cellPure(p, head, indexEntry?.oid, inWd, matcher));
      }
      const hashed = yield* Effect.forEach(
        needsHash,
        (p) => cellHashing(cfg, p, headByPath.get(p), indexByPath.get(p), matcher),
        { concurrency: 256 }
      );
      const cells = [...pure, ...hashed];
      return Stream.fromIterable(cells.flatMap((c) => (Option.isSome(c) ? [c.value] : [])));
    })
  );
