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
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { WorkdirIoError } from './errors';
import { readIndex, type IndexEntry } from './indexV2';
import { hashBlob } from './objects';
import { type Oid, type RepoPath, RepoPath as RepoPathSchema, type StatusEntry } from './schemas';
import { streamHeadTree } from './trees';

const isNotFound = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'NotFound';

/** Build the `ignore` matcher from `.git/info/exclude`. Empty if absent. */
const loadIgnoreMatcher = Effect.fn('loadIgnoreMatcher')(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const file = path.join(gitdir, 'info', 'exclude');
  const content = yield* fs
    .readFileString(file)
    .pipe(
      Effect.catchAll((cause) =>
        isNotFound(cause as never) ? Effect.succeed('') : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
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
      isNotFound(cause as never)
        ? Effect.succeed({ kind: 'absent' as const })
        : Effect.fail(WorkdirIoError.fromPlatformError(absRoot, cause))
    )
  );
  if (rootStat.kind === 'absent') return [] as readonly string[];
  if (rootStat.type !== 'Directory') return [rootRel] as readonly string[];

  const entries = yield* fs
    .readDirectory(absRoot, { recursive: true })
    .pipe(
      Effect.catchAll((cause) =>
        isNotFound(cause as never)
          ? Effect.succeed([] as readonly string[])
          : Effect.fail(WorkdirIoError.fromPlatformError(absRoot, cause))
      )
    );
  const relPaths = entries.map((e) => `${rootRel}/${e.replaceAll('\\', '/')}`);
  // ENOENT mid-walk: silently drop (Option.none). Other errors surface.
  const stats = yield* Effect.forEach(
    relPaths,
    (rel) =>
      fs.stat(path.join(dir, rel)).pipe(
        Effect.map((info) => Option.some({ rel, type: info.type })),
        Effect.catchAll((cause) =>
          isNotFound(cause as never)
            ? Effect.succeed(Option.none<{ rel: string; type: string }>())
            : Effect.fail(WorkdirIoError.fromPlatformError(rel, cause))
        )
      ),
    { concurrency: 'unbounded' }
  );
  return stats.flatMap((opt) =>
    Option.match(opt, {
      onNone: () => [],
      onSome: (s) => (s.type !== 'Directory' ? [s.rel] : []),
    })
  ) as readonly string[];
});

/**
 * Walk all files under `dir/<root>` for each root in cfg.roots. Posix paths
 * relative to `dir`. ENOENT mid-walk silently dropped.
 */
const collectWorkdirFiles = Effect.fn('collectWorkdirFiles')(function* (dir: string, roots: readonly RepoPath[]) {
  const perRoot = yield* Effect.forEach(roots, (r) => walkOneRoot(dir, r), { concurrency: 'unbounded' });
  return perRoot.flat();
});

/** Predicate: does `p` live under any of `roots`? Exact match or prefix-with-slash. */
const inRoots = (p: string, roots: readonly RepoPath[]): boolean =>
  roots.includes(p as RepoPath) || roots.some((r) => p.startsWith(`${r}/`));

/**
 * Stat-trust check: if the workdir stat (size + mtime ms) matches the index
 * entry, trust the recorded oid. Real-git's racy-stat behavior. Returns
 * `Some(oid)` on a hit, `None` on a miss (caller should rehash).
 */
const statTrustOid = Effect.fn('statTrustOid')(function* (abs: string, index: IndexEntry | undefined) {
  if (index === undefined || index.stat.size === 0) return Option.none<Oid>();
  const fs = yield* FileSystem;
  const stat = yield* fs.stat(abs).pipe(
    Effect.map((s) => Option.some(s)),
    Effect.catchAll(() => Effect.succeed(Option.none<never>()))
  );
  if (Option.isNone(stat)) return Option.none<Oid>();
  const info = stat.value as unknown as { size: bigint; mtime: Option.Option<Date> };
  const mtimeMs = Option.getOrElse(info.mtime, () => new Date(0)).getTime();
  const recordedMs = index.stat.mtimeSec * 1000 + Math.floor(index.stat.mtimeNsec / 1_000_000);
  return Number(info.size) === index.stat.size && mtimeMs === recordedMs ? Option.some(index.oid) : Option.none<Oid>();
});

/** Hash workdir bytes for one path, or None if the file vanished mid-walk. */
const hashWorkdirOid = Effect.fn('hashWorkdirOid')(function* (abs: string) {
  const fs = yield* FileSystem;
  const bytes = yield* fs.readFile(abs).pipe(
    Effect.map((b) => Option.some(b)),
    Effect.catchAll((cause) =>
      isNotFound(cause as never)
        ? Effect.succeed(Option.none<Uint8Array>())
        : Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))
    )
  );
  if (Option.isNone(bytes)) return Option.none<Oid>();
  return Option.some(yield* hashBlob(bytes.value));
});

/** Resolve the workdir oid for one path: stat-trust first, then rehash. */
const workdirOidFor = Effect.fn('workdirOidFor')(function* (dir: string, rel: string, index: IndexEntry | undefined) {
  const path = yield* Path;
  const abs = path.join(dir, rel);
  const trusted = yield* statTrustOid(abs, index);
  if (Option.isSome(trusted)) return trusted;
  return yield* hashWorkdirOid(abs);
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
  matcher: Ignore
): Option.Option<StatusEntry> => {
  const path = Schema.decodeUnknownSync(RepoPathSchema)(rawPath);
  if (head === undefined && index === undefined) {
    if (workdir === undefined) return Option.none();
    return Option.some(matcher.ignores(rawPath) ? { path, status: 'ignored' } : { path, status: 'added' });
  }
  if (workdir === undefined) return Option.some({ path, status: 'deleted' });
  if (head === workdir && index === workdir) return Option.some({ path, status: 'unmodified' });
  return Option.some({ path, status: 'modified' });
};

const cellFor = Effect.fn('cellFor')(function* (
  cfg: { readonly dir: string },
  rel: string,
  head: Oid | undefined,
  index: IndexEntry | undefined,
  inWorkdir: boolean,
  matcher: Ignore
) {
  const workdirOid = inWorkdir ? yield* workdirOidFor(cfg.dir, rel, index) : Option.none<Oid>();
  return collapse(rel, head, index?.oid, Option.getOrUndefined(workdirOid), matcher);
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

      const headPairs: ReadonlyArray<readonly [string, Oid]> = yield* streamHeadTree(cfg.gitdir).pipe(
        Stream.map((p) => [p.path, p.oid] as const),
        Stream.runCollect,
        Effect.map((c) => Array.from(c))
      );
      const headByPath = new Map(headPairs);

      const workdirFiles = yield* collectWorkdirFiles(cfg.dir, cfg.roots);
      const workdirSet = new Set(workdirFiles);

      // Union all keys, filter to roots, sort once.
      const allPaths = Array.from(new Set([...headByPath.keys(), ...indexByPath.keys(), ...workdirFiles]))
        .filter((p) => inRoots(p, cfg.roots))
        .sort();

      const cells = yield* Effect.forEach(
        allPaths,
        (p) => cellFor(cfg, p, headByPath.get(p), indexByPath.get(p), workdirSet.has(p), matcher),
        { concurrency: 'unbounded' }
      );
      return Stream.fromIterable(cells.flatMap((c) => (Option.isSome(c) ? [c.value] : [])));
    })
  );
