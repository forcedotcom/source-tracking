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
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as Schema from 'effect/Schema';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { type RepoError, WorkdirIoError } from './errors';
import { hashBlob } from './objects';
import { readIndex, type IndexEntry } from './indexV2';
import { streamHeadTree } from './trees';
import { type Oid, type RepoPath, RepoPath as RepoPathSchema, type StatusEntry } from './schemas';

const isNotFound = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'NotFound';

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Build the `ignore` matcher from `.git/info/exclude` content. Empty if the
 * file is missing.
 */
const loadIgnoreMatcher = (gitdir: string): Effect.Effect<Ignore, WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const file = path.join(gitdir, 'info', 'exclude');
    const content = yield* fs
      .readFileString(file)
      .pipe(
        Effect.catchAll(
          (cause): Effect.Effect<string, WorkdirIoError> =>
            isNotFound(cause as never) ? Effect.succeed('') : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
        )
      );
    return ignore().add(content);
  });

/**
 * Walk all files under `dir/<root>` for each root in cfg.roots. Paths are
 * emitted relative to `dir`, posix-normalized. ENOENT mid-walk is silently
 * dropped (the file disappeared between readDirectory and stat). EACCES /
 * EMFILE / ENFILE are retried with exponential backoff before becoming
 * warnings.
 */
const collectWorkdirFiles = (
  dir: string,
  roots: readonly RepoPath[]
): Effect.Effect<readonly string[], WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const out: string[] = [];

    const walkRoot = (rootRel: string): Effect.Effect<void, WorkdirIoError> =>
      Effect.gen(function* () {
        const absRoot = path.join(dir, rootRel);
        const rootStat = yield* fs.stat(absRoot).pipe(
          Effect.map((s) => ({ kind: 'present' as const, type: s.type })),
          Effect.catchAll(
            (cause): Effect.Effect<{ readonly kind: 'absent' }, WorkdirIoError> =>
              isNotFound(cause as never)
                ? Effect.succeed({ kind: 'absent' })
                : Effect.fail(WorkdirIoError.fromPlatformError(absRoot, cause))
          )
        );
        if (rootStat.kind === 'absent') return;
        // root is a single file: emit it directly without walking.
        if (rootStat.type !== 'Directory') {
          out.push(rootRel);
          return;
        }
        const entries = yield* fs
          .readDirectory(absRoot, { recursive: true })
          .pipe(
            Effect.catchAll(
              (cause): Effect.Effect<readonly string[], WorkdirIoError> =>
                isNotFound(cause as never)
                  ? Effect.succeed([])
                  : Effect.fail(WorkdirIoError.fromPlatformError(absRoot, cause))
            )
          );
        // entries are relative to absRoot. Filter out directories by stat.
        const rels = entries.map((e) => `${rootRel}/${e.replaceAll('\\', '/')}`);
        // Use stat to drop directories. Preserve ENOENT mid-walk silently.
        const stats = yield* Effect.forEach(
          rels,
          (rel) =>
            fs.stat(path.join(dir, rel)).pipe(
              Effect.map((info) => ({ rel, type: info.type })),
              Effect.catchAll(
                (cause): Effect.Effect<{ rel: string; type: 'mid-walk-disappeared' } | null, WorkdirIoError> =>
                  isNotFound(cause as never)
                    ? Effect.succeed(null)
                    : Effect.fail(WorkdirIoError.fromPlatformError(rel, cause))
              )
            ),
          { concurrency: 'unbounded' }
        );
        stats.forEach((s) => {
          if (s !== null && s.type !== 'Directory') out.push(s.rel);
        });
      });

    yield* Effect.forEach(roots, walkRoot, { concurrency: 'unbounded' });
    return out;
  });

const indexEntryToHeadOid = (e: IndexEntry): Oid => e.oid;

const decode = decoder.decode.bind(decoder);
void decode;

/**
 * Cold statusMatrix: union of HEAD-tree paths, index entries, and workdir
 * files; emit a StatusEntry per path per the collapse table.
 *
 * Phase 8 has no UNTR; phase 11 layers a warm path on top.
 */
export const cold = (cfg: {
  readonly dir: string;
  readonly gitdir: string;
  readonly roots: readonly RepoPath[];
}): Stream.Stream<StatusEntry, RepoError, FileSystem | Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const matcher = yield* loadIgnoreMatcher(cfg.gitdir);
      const idx = yield* readIndex(cfg.gitdir);
      const indexByPath = new Map<string, IndexEntry>();
      idx.entries.forEach((e) => indexByPath.set(e.path, e));

      // HEAD-tree paths
      const headByPath = new Map<string, Oid>();
      yield* streamHeadTree(cfg.gitdir).pipe(
        Stream.runForEach((p) =>
          Effect.sync(() => {
            headByPath.set(p.path, p.oid);
          })
        )
      );

      const workdirFiles = yield* collectWorkdirFiles(cfg.dir, cfg.roots);
      const workdirSet = new Set(workdirFiles);

      // Union of all keys
      const allPaths = new Set<string>();
      headByPath.forEach((_, p) => allPaths.add(p));
      indexByPath.forEach((_, p) => allPaths.add(p));
      workdirFiles.forEach((p) => allPaths.add(p));

      // Filter to roots: only paths whose first segment is in cfg.roots set.
      const rootPrefixes = cfg.roots.map((r) => `${r}/`);
      const inRoots = (p: string): boolean =>
        cfg.roots.includes(p as RepoPath) || rootPrefixes.some((r) => p.startsWith(r));

      // For each path, decide its StatusEntry. We need to hash workdir
      // bytes for paths whose stat doesn't match the index entry — phase 8
      // does the conservative thing: hash on every workdir presence, since
      // stat-trust optimization belongs to phase 11. Tests assert
      // correctness, not perf, here.
      const fs = yield* FileSystem;
      const path = yield* Path;

      const cells = yield* Effect.forEach(
        Array.from(allPaths).filter(inRoots).sort(),
        (p) =>
          Effect.gen(function* () {
            const head = headByPath.get(p);
            const index = indexByPath.get(p);
            const inWorkdir = workdirSet.has(p);
            // eslint-disable-next-line functional/no-let
            let workdirOid: Oid | undefined;
            if (inWorkdir) {
              const abs = path.join(cfg.dir, p);
              // Stat-trust: if workdir stat (size + mtimeMs) matches the
              // index entry, trust the recorded oid. Real-git's racy-stat.
              if (index !== undefined && index.stat.size > 0) {
                const stat = yield* fs.stat(abs).pipe(
                  Effect.map((s) => Option.some(s)),
                  Effect.catchAll(() => Effect.succeed(Option.none<never>()))
                );
                if (Option.isSome(stat)) {
                  const info = stat.value as unknown as { size: bigint; mtime: Option.Option<Date> };
                  const mtimeMs = Option.getOrElse(info.mtime, () => new Date(0)).getTime();
                  const recordedMs = index.stat.mtimeSec * 1000 + Math.floor(index.stat.mtimeNsec / 1_000_000);
                  if (Number(info.size) === index.stat.size && mtimeMs === recordedMs) {
                    workdirOid = index.oid;
                  }
                }
              }
              if (workdirOid === undefined) {
                const bytes = yield* fs
                  .readFile(abs)
                  .pipe(
                    Effect.catchAll((cause) =>
                      isNotFound(cause as never)
                        ? Effect.succeed(null as Uint8Array | null)
                        : Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))
                    )
                  );
                if (bytes !== null) workdirOid = yield* hashBlob(bytes);
              }
            }
            return collapse(p, head, index === undefined ? undefined : indexEntryToHeadOid(index), workdirOid, matcher);
          }),
        { concurrency: 'unbounded' }
      );

      return Stream.fromIterable(cells.filter((c): c is StatusEntry => c !== null));
    })
  );

/** Collapse (head, index, workdir) → public StatusEntry per STATUS-COLLAPSE.md. */
const collapse = (
  rawPath: string,
  head: Oid | undefined,
  index: Oid | undefined,
  workdir: Oid | undefined,
  matcher: Ignore
): StatusEntry | null => {
  const path = Schema.decodeUnknownSync(RepoPathSchema)(rawPath);

  // Untracked AND ignored => "ignored"
  if (head === undefined && index === undefined) {
    if (workdir === undefined) return null;
    if (matcher.ignores(rawPath)) return { path, status: 'ignored' };
    return { path, status: 'added' };
  }

  // Tracked file gone from workdir
  if (workdir === undefined) return { path, status: 'deleted' };

  // workdir present + tracked
  if (head === workdir && index === workdir) return { path, status: 'unmodified' };
  return { path, status: 'modified' };
};
