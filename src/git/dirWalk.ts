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
import { type File as PlatformFile, FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { WorkdirIoError } from './errors';
import { type IgnoreChain, buildLink, chainIgnores, emptyChain } from './ignoreChain';
import type { RepoPath } from './schemas';

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

const GITIGNORE = '.gitignore';
const TEXT = new TextDecoder('utf-8', { fatal: false });

/**
 * One directory's snapshot, taken non-recursively. Returned by
 * [[walkOneDir]] and consumed by both `coldStatus` and the warm-cache
 * builder. Subdir entries surface as `subdirs` so callers can decide how
 * to recurse (cold descends inline; warm builder schedules per-dir
 * concurrent recursion).
 *
 * `dirMtimeMs` and `totalEntryCount` make up the per-dir fingerprint
 * stored in the UNTR cache. `gitignoreMtimeMs === 0` means no
 * `.gitignore` is present in this directory.
 */
export type DirSnapshot = {
  /** Posix workdir-relative path; '' for the root. */
  readonly dir: string;
  readonly dirMtimeMs: number;
  /** File children + subdir children + .gitignore. Used in the per-dir fingerprint. */
  readonly totalEntryCount: number;
  /** mtime of `<dir>/.gitignore`; 0 if absent. */
  readonly gitignoreMtimeMs: number;
  /** Some(content) if `<dir>/.gitignore` exists; None otherwise. Some('') if empty. */
  readonly gitignoreContent: Option.Option<string>;
  /** Basenames of regular files in this dir (excluding `.gitignore`). */
  readonly fileNames: readonly string[];
  /** Basenames of subdirectories in this dir. */
  readonly subdirNames: readonly string[];
};

const statOptional = (fs: FileSystem, abs: string) =>
  fs.stat(abs).pipe(
    Effect.map((info): Option.Option<PlatformFile.Info> => Option.some(info)),
    Effect.catchAll((cause) =>
      isNotFound(cause)
        ? Effect.succeed(Option.none<PlatformFile.Info>())
        : Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))
    )
  );

/**
 * Walk one directory non-recursively. Returns Option.none if the dir is
 * absent or is a file. Quietly skips entries that disappear mid-walk.
 *
 * fnUntraced because callers walk many dirs concurrently and a per-dir
 * span would dominate the trace stream; the parent operation's
 * aggregate-count annotation is the right granularity.
 */
export const walkOneDir = Effect.fnUntraced(function* (workdir: string, dirRel: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const abs = dirRel === '' ? workdir : path.join(workdir, dirRel);

  const dirInfo = yield* statOptional(fs, abs);
  if (Option.isNone(dirInfo) || dirInfo.value.type !== 'Directory') return Option.none<DirSnapshot>();

  const names: readonly string[] = yield* fs
    .readDirectory(abs)
    .pipe(
      Effect.catchAll((cause) =>
        isNotFound(cause) ? Effect.succeed([]) : Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))
      )
    );

  // Stat each child concurrently. ENOENT during stat is silently dropped.
  const children = yield* Effect.forEach(
    names,
    (name) =>
      fs.stat(path.join(abs, name)).pipe(
        Effect.map((info) => Option.some({ name, type: info.type })),
        Effect.catchAll((cause) =>
          isNotFound(cause)
            ? Effect.succeed(Option.none<{ name: string; type: string }>())
            : Effect.fail(WorkdirIoError.fromPlatformError(path.join(abs, name), cause))
        )
      ),
    { concurrency: 'unbounded' }
  );

  const realChildren = children.flatMap((c) =>
    Option.match(c, { onNone: (): ReadonlyArray<{ name: string; type: string }> => [], onSome: (s) => [s] })
  );
  const fileNames = realChildren.filter((c) => c.type !== 'Directory' && c.name !== GITIGNORE).map((c) => c.name);
  const subdirNames = realChildren.filter((c) => c.type === 'Directory').map((c) => c.name);
  const hasGitignore = realChildren.some((c) => c.type !== 'Directory' && c.name === GITIGNORE);
  const dirMtimeMs = Option.getOrElse(dirInfo.value.mtime, () => new Date(0)).getTime();

  const gitignore = hasGitignore
    ? yield* readGitignoreSnapshot(path.join(abs, GITIGNORE))
    : { mtimeMs: 0, content: Option.none<string>() };

  return Option.some<DirSnapshot>({
    dir: dirRel,
    dirMtimeMs,
    totalEntryCount: realChildren.length,
    gitignoreMtimeMs: gitignore.mtimeMs,
    gitignoreContent: gitignore.content,
    fileNames,
    subdirNames,
  });
});

const readGitignoreSnapshot = Effect.fnUntraced(function* (giAbs: string) {
  const fs = yield* FileSystem;
  const info = yield* statOptional(fs, giAbs);
  if (Option.isNone(info)) return { mtimeMs: 0, content: Option.none<string>() };
  const bytes = yield* fs.readFile(giAbs).pipe(
    Effect.map(Option.some),
    Effect.catchAll((cause) =>
      isNotFound(cause)
        ? Effect.succeed(Option.none<Uint8Array>())
        : Effect.fail(WorkdirIoError.fromPlatformError(giAbs, cause))
    )
  );
  if (Option.isNone(bytes)) return { mtimeMs: 0, content: Option.none<string>() };
  return {
    mtimeMs: Option.getOrElse(info.value.mtime, () => new Date(0)).getTime(),
    content: Option.some(TEXT.decode(bytes.value)),
  };
});

/** Stat the `.git/info/exclude` mtime. 0 if absent. */
export const infoExcludeMtime = Effect.fnUntraced(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const file = path.join(gitdir, 'info', 'exclude');
  const info = yield* statOptional(fs, file);
  return Option.match(info, {
    onNone: () => 0,
    onSome: (i) => Option.getOrElse(i.mtime, () => new Date(0)).getTime(),
  });
});

/** Read `.git/info/exclude` content. '' if absent. */
export const readInfoExclude = Effect.fnUntraced(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const file = path.join(gitdir, 'info', 'exclude');
  const bytes = yield* fs.readFile(file).pipe(
    Effect.map(Option.some),
    Effect.catchAll((cause) =>
      isNotFound(cause)
        ? Effect.succeed(Option.none<Uint8Array>())
        : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
    )
  );
  return Option.match(bytes, { onNone: () => '', onSome: (b) => TEXT.decode(b) });
});

/** Posix dir of a path: 'src/foo/bar.ts' → 'src/foo'; 'a.ts' → ''. */
export const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/**
 * Per-directory snapshot tagged with the ignore-chain that was effective
 * inside that directory. Used by cold (to classify untracked basenames at
 * walk time) and by warm-build (to populate the cache's `untracked`
 * resolution per directory).
 */
export type WalkNode = {
  readonly snapshot: DirSnapshot;
  readonly chain: IgnoreChain;
};

/**
 * Walk all `cfg.roots` recursively, accumulating one `WalkNode` per
 * directory observed. Subdirectory recursion fans out at
 * `concurrency: cfg.fdPermits`; per-dir child stats inside `walkOneDir`
 * stay unbounded (the outer cap meters the global fd footprint).
 */
// recursive Effect.gen needs the explicit return type so TS can resolve
// the self-call inside the body.
// eslint-disable-next-line local-rules/no-explicit-effect-return-type
const walkRecursive: (
  workdir: string,
  rootRel: string,
  baseChain: IgnoreChain,
  fdPermits: number
) => Effect.Effect<readonly WalkNode[], WorkdirIoError, FileSystem | Path> = (workdir, rootRel, baseChain, fdPermits) =>
  Effect.gen(function* () {
    const snap = yield* walkOneDir(workdir, rootRel);
    if (Option.isNone(snap)) return [];
    const localChain = Option.match(snap.value.gitignoreContent, {
      onNone: () => baseChain,
      onSome: (content) => [...baseChain, buildLink(snap.value.dir, content)],
    });
    const here: WalkNode = { snapshot: snap.value, chain: localChain };
    const childRels = snap.value.subdirNames.map((n) => (snap.value.dir === '' ? n : `${snap.value.dir}/${n}`));
    const subResults = yield* Effect.forEach(childRels, (c) => walkRecursive(workdir, c, localChain, fdPermits), {
      concurrency: fdPermits,
    });
    return [here, ...subResults.flat()];
  });

/**
 * The aggregate of a full multi-root walk: `nodes` (one per directory
 * observed; depth-first within each root, roots in parallel) and
 * `isIgnoredAtRoot` (answers the ignore question using the root-level
 * chain only — used by cold for bare file-roots that don't surface as
 * directory snapshots).
 */
export type WalkResult = {
  readonly nodes: readonly WalkNode[];
  readonly isIgnoredAtRoot: (p: string) => boolean;
};

/**
 * Build a per-node `isIgnored(rel)` oracle. The chain attached to each
 * node already covers ancestors via the chain accumulation in
 * `walkRecursive`, so callers can ignore-classify a basename directly
 * with `chainIgnores(node.chain, fullPath)`.
 */
export const nodeIgnores = (node: WalkNode, fullPath: string): boolean => chainIgnores(node.chain, fullPath);

export const walkAllRoots = Effect.fn('walkAllRoots')(function* (
  cfg: { readonly dir: string; readonly roots: readonly RepoPath[]; readonly fdPermits: number },
  excludeContent: string
) {
  const baseChain: IgnoreChain = excludeContent === '' ? emptyChain() : [buildLink('', excludeContent)];
  const nested = yield* Effect.forEach(cfg.roots, (r) => walkRecursive(cfg.dir, r, baseChain, cfg.fdPermits), {
    concurrency: cfg.fdPermits,
  });
  // Project a per-node oracle out of the chain attached to each node.
  // Cold's bare-file-roots use the root-level chain because they're not
  // attached to any DirSnapshot.
  const isIgnoredAtRoot = (p: string): boolean => chainIgnores(baseChain, p);
  return { nodes: nested.flat(), isIgnoredAtRoot } satisfies WalkResult;
});
