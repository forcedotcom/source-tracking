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
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Semaphore from 'effect/Semaphore';
import type { PlatformError } from 'effect/PlatformError';
import { type IgnoreChain, buildLink, chainIgnores, emptyChain } from './ignoreChain.js';
import type { RepoPath } from './schemas.js';
import { gitModeFromStat, lstat } from './workdir.js';

const GITIGNORE = '.gitignore';
const TEXT = new TextDecoder('utf-8', { fatal: false });

type WalkProfile = {
  visitedDirectories: number;
  childEntries: number;
  lstatOperations: number;
  gitignoreFiles: number;
  maxChildCohort: number;
  maxDepth: number;
};

/**
 * One directory's snapshot, taken non-recursively. Returned by
 * [[walkOneDir]] and consumed by the cold status scan. Subdir entries
 * surface as `subdirs` so the walker can recurse with bounded concurrency.
 */
type DirSnapshot = {
  /** Posix workdir-relative path; '' for the root. */
  readonly dir: string;
  /** Some(content) if `<dir>/.gitignore` exists; None otherwise. Some('') if empty. */
  readonly gitignoreContent: Option.Option<string>;
  /** Basenames of files and symlinks in this dir (excluding `.gitignore`). */
  readonly fileNames: readonly string[];
  /** Git file modes keyed by basename. */
  readonly fileModes: ReadonlyMap<string, number>;
  /** Basenames of subdirectories in this dir. */
  readonly subdirNames: readonly string[];
};

const statOptional = (abs: string, ioSemaphore: Semaphore.Semaphore, profile?: WalkProfile) =>
  (profile
    ? Effect.suspend(() => {
        profile.lstatOperations += 1;
        return lstat(abs);
      })
    : lstat(abs)
  ).pipe(
    Semaphore.withPermits(ioSemaphore, 1),
    Effect.map(Option.some),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<Stats>()))
  );

/**
 * Walk one directory non-recursively. Returns Option.none if the dir is
 * absent or is a file. Quietly skips entries that disappear mid-walk.
 *
 * fnUntraced because callers walk many dirs concurrently and a per-dir
 * span would dominate the trace stream; the parent operation's
 * aggregate-count annotation is the right granularity.
 */
const walkOneDir = Effect.fnUntraced(function* (
  workdir: string,
  dirRel: string,
  ioSemaphore: Semaphore.Semaphore,
  profile?: WalkProfile
) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const abs = dirRel === '' ? workdir : path.join(workdir, dirRel);

  const dirInfo = yield* statOptional(abs, ioSemaphore, profile);
  if (Option.isNone(dirInfo) || !dirInfo.value.isDirectory()) return Option.none<DirSnapshot>();
  if (profile) {
    profile.visitedDirectories += 1;
    profile.maxDepth = Math.max(profile.maxDepth, dirRel === '' ? 0 : dirRel.split('/').length);
  }

  // All roots and descendants share the same I/O permits. ENOENT is silently dropped.
  const realChildren = yield* fs.readDirectory(abs).pipe(
    Semaphore.withPermits(ioSemaphore, 1),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed([])),
    Effect.flatMap((names) => {
      if (profile) {
        profile.childEntries += names.length;
        profile.maxChildCohort = Math.max(profile.maxChildCohort, names.length);
      }
      return Effect.forEach(
        names,
        (name) =>
          statOptional(path.join(abs, name), ioSemaphore, profile).pipe(
            Effect.map(Option.map((info) => ({ name, info })))
          ),
        { concurrency: 'unbounded' }
      );
    }),
    Effect.map((children) => children.flatMap((c) => Option.match(c, { onNone: () => [], onSome: (s) => [s] })))
  );
  const files = realChildren.filter((c) => !c.info.isDirectory() && c.name !== GITIGNORE);
  const fileNames = files.map((c) => c.name);
  const fileModes = new Map(files.map((c) => [c.name, gitModeFromStat(c.info)] satisfies readonly [string, number]));
  const subdirNames = realChildren.filter((c) => c.info.isDirectory()).map((c) => c.name);
  const hasGitignore = realChildren.some((c) => !c.info.isDirectory() && c.name === GITIGNORE);
  if (profile && hasGitignore) profile.gitignoreFiles += 1;
  const gitignoreContent = hasGitignore
    ? yield* readGitignoreSnapshot(path.join(abs, GITIGNORE), ioSemaphore, profile)
    : Option.none<string>();

  return Option.some<DirSnapshot>({
    dir: dirRel,
    gitignoreContent,
    fileNames,
    fileModes,
    subdirNames,
  });
});

const readGitignoreSnapshot = Effect.fnUntraced(function* (
  giAbs: string,
  ioSemaphore: Semaphore.Semaphore,
  profile?: WalkProfile
) {
  const fs = yield* FileSystem;
  const info = yield* statOptional(giAbs, ioSemaphore, profile);
  if (Option.isNone(info)) return Option.none<string>();
  return yield* fs.readFile(giAbs).pipe(
    Semaphore.withPermits(ioSemaphore, 1),
    Effect.map(Option.some),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<Uint8Array>())),
    Effect.map((bytes) => Option.map(bytes, (b) => TEXT.decode(b)))
  );
});

/** Read `.git/info/exclude` content. '' if absent. */
export const readInfoExclude = Effect.fnUntraced(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const file = path.join(gitdir, 'info', 'exclude');
  return yield* fs.readFile(file).pipe(
    Effect.map(Option.some),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<Uint8Array>())),
    Effect.map((bytes) => Option.match(bytes, { onNone: () => '', onSome: (b) => TEXT.decode(b) }))
  );
});

/**
 * Per-directory snapshot tagged with the ignore-chain effective inside
 * that directory, used to classify untracked basenames during the walk.
 */
export type WalkNode = {
  readonly snapshot: DirSnapshot;
  readonly chain: IgnoreChain;
};

/**
 * Walk all `cfg.roots` recursively, accumulating one `WalkNode` per
 * directory observed. Each filesystem call acquires a shared I/O permit;
 * no permit is held while waiting for child directories to finish.
 */
// Recursive calls need the explicit return type so TS can resolve
// the self-call inside the body.
const walkRecursive: (
  workdir: string,
  rootRel: string,
  baseChain: IgnoreChain,
  fdPermits: number,
  ioSemaphore: Semaphore.Semaphore,
  profile?: WalkProfile
) => Effect.Effect<readonly WalkNode[], PlatformError, FileSystem | Path> = Effect.fnUntraced(function* (
  workdir,
  rootRel,
  baseChain,
  fdPermits,
  ioSemaphore,
  profile
) {
  const snap = yield* walkOneDir(workdir, rootRel, ioSemaphore, profile);
  if (Option.isNone(snap)) return [];
  const localChain = Option.match(snap.value.gitignoreContent, {
    onNone: () => baseChain,
    onSome: (content) => [...baseChain, buildLink(snap.value.dir, content)],
  });
  const here: WalkNode = { snapshot: snap.value, chain: localChain };
  const childRels = snap.value.subdirNames.map((n) => (snap.value.dir === '' ? n : `${snap.value.dir}/${n}`));
  return yield* Effect.forEach(
    childRels,
    (c) => walkRecursive(workdir, c, localChain, fdPermits, ioSemaphore, profile),
    {
      concurrency: fdPermits,
    }
  ).pipe(Effect.map((subResults) => [here, ...subResults.flat()]));
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
  excludeContent: string,
  profile?: WalkProfile
) {
  const ioSemaphore = yield* Semaphore.make(cfg.fdPermits);
  const baseChain: IgnoreChain = excludeContent === '' ? emptyChain() : [buildLink('', excludeContent)];
  // Project a per-node oracle out of the chain attached to each node.
  // Cold's bare-file-roots use the root-level chain because they're not
  // attached to any DirSnapshot.
  const isIgnoredAtRoot = (p: string): boolean => chainIgnores(baseChain, p);
  return yield* Effect.forEach(
    cfg.roots,
    (r) => walkRecursive(cfg.dir, r, baseChain, cfg.fdPermits, ioSemaphore, profile),
    {
      concurrency: cfg.fdPermits,
    }
  ).pipe(
    Effect.map((nested) => ({ nodes: nested.flat(), isIgnoredAtRoot } satisfies WalkResult)),
    Effect.tap(({ nodes }) => Effect.annotateCurrentSpan({ rootCount: cfg.roots.length, directoryCount: nodes.length }))
  );
});
