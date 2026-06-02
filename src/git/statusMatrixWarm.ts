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
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import ignore from 'ignore';
import { infoExcludeMtime, readInfoExclude, walkOneDir } from './dirWalk';
import { WorkdirIoError } from './errors';
import { readIndex } from './indexV2';
import { type Oid, type StatusEntry, type SwitchCfg } from './schemas';
import { collectBareFileRoots, evaluateMatrix, type UntrackedClassification } from './statusMatrix';
import { streamHeadTree } from './trees';
import { type LoadedUntrCache, type UntrCache } from './untrCache';
import { trackedByDir } from './untrBuild';

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

/**
 * Outcome of a warm-path attempt. `'invalidated'` means the caller MUST
 * fall back to cold + rebuild; `'ok'` carries the StatusEntry stream.
 */
export type WarmOutcome =
  | { readonly kind: 'ok'; readonly entries: readonly StatusEntry[] }
  | { readonly kind: 'invalidated'; readonly reason: string };

/**
 * Stat each cached directory and check its fingerprint matches. Returns
 * `{ stale, fresh }` partition: `stale` directories must be re-walked
 * inline; `fresh` ones contribute their cached basenames directly.
 *
 * A dir whose stat fails with NotFound is treated as stale (the dir
 * disappeared since the cache was written; we'll walk-it-fresh and find
 * an empty result, dropping its prior contents from the workdir set).
 */
const partitionByFingerprint = (workdir: string, cache: UntrCache, fdPermits: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const dirs = HashMap.toEntries(cache.entries);
    type Item = readonly [string, { readonly kind: 'fresh' } | { readonly kind: 'stale'; readonly reason: string }];
    const checkOne = ([dirRel]: readonly [string, unknown]) =>
      Effect.gen(function* () {
        const abs = dirRel === '' ? workdir : path.join(workdir, dirRel);
        const info = yield* fs.stat(abs).pipe(
          Effect.map(Option.some),
          Effect.catchAll((cause) =>
            isNotFound(cause)
              ? Effect.succeed(Option.none<PlatformFile.Info>())
              : Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))
          )
        );
        if (Option.isNone(info) || info.value.type !== 'Directory') {
          return [dirRel, { kind: 'stale' as const, reason: 'dir-vanished' }] as Item;
        }
        const want = HashMap.unsafeGet(cache.entries, dirRel).fingerprint;
        const mtimeMs = Option.getOrElse(info.value.mtime, () => new Date(0)).getTime();
        if (mtimeMs !== want.mtimeMs) return [dirRel, { kind: 'stale' as const, reason: 'dir-mtime' }] as Item;
        return [dirRel, { kind: 'fresh' as const }] as Item;
      });
    return yield* Effect.forEach(dirs, checkOne, { concurrency: fdPermits });
  });

/**
 * Walk one stale directory fresh and produce its (workdirSet,
 * untrackedClassification) contribution. Honors nested .gitignore via the
 * passed-in chain — but the warm path does NOT have access to ancestor
 * chains in the same way buildUntrCache does, because the cache stores
 * resolved status not the chain itself.
 *
 * Workaround: walk the dir fresh and resolve its untracked basenames
 * against the SAME set of rules that produced the cache — i.e. the
 * `.git/info/exclude` content + this dir's `.gitignore`. This is correct
 * for any case the cache validates against: if any `.gitignore` (in this
 * dir OR an ancestor) was edited, the corresponding directory's
 * `gitignoreMtimeMs` advanced (or `info/exclude`'s did), and the cache
 * was full-invalidated upstream of this call.
 *
 * Caveat: the walk uses the dir-local matcher only (parent's
 * `.gitignore`s are not re-evaluated). If a parent's `.gitignore` rule
 * applies to a path under this dir AND we got here via a stale-dir
 * re-walk, we miss that rule. The plan accepts this: the warm path's
 * stale-dir fallback exists for "single dir mutated" scenarios; if a
 * parent's `.gitignore` changed, its own fingerprint advanced and that
 * branch's cache gets dropped before we ever look at descendant slices.
 */
const walkStaleDir = (workdir: string, dirRel: string, excludeContent: string) =>
  Effect.gen(function* () {
    const snap = yield* walkOneDir(workdir, dirRel);
    if (Option.isNone(snap)) return null;
    // Build the per-dir matcher from info/exclude + this dir's .gitignore.
    const matcher = ignore();
    if (excludeContent !== '') matcher.add(excludeContent);
    const localContent = Option.getOrElse(snap.value.gitignoreContent, () => '');
    if (localContent !== '') matcher.add(localContent);
    const workdirSet = new Set<string>();
    const untracked = new Map<string, 'added' | 'ignored'>();
    // eslint-disable-next-line functional/no-loop-statements
    for (const name of snap.value.fileNames) {
      const rel = snap.value.dir === '' ? name : `${snap.value.dir}/${name}`;
      workdirSet.add(rel);
      // Tracked-vs-untracked is determined by the index, not by the dir
      // walk; the caller layers index membership over our results.
      untracked.set(rel, matcher.ignores(rel) ? 'ignored' : 'added');
    }
    return {
      workdirSet,
      untracked,
      fingerprint: {
        mtimeMs: snap.value.dirMtimeMs,
        size: snap.value.totalEntryCount,
        gitignoreMtimeMs: snap.value.gitignoreMtimeMs,
      },
    };
  });

/**
 * Reconstitute the (workdirSet, untrackedClassification) tuple from
 * cache entries + per-dir-stat fingerprint validation. Stale dirs are
 * walked inline; fresh dirs use the cached resolution directly.
 */
const collectFromCache = (cfg: SwitchCfg, cache: UntrCache, excludeContent: string) =>
  Effect.gen(function* () {
    const checks = yield* partitionByFingerprint(cfg.dir, cache, cfg.fdPermits);
    const workdirSet = new Set<string>();
    const untracked = new Map<string, 'added' | 'ignored'>();
    // eslint-disable-next-line functional/no-loop-statements
    for (const [dirRel, status] of checks) {
      if (status.kind === 'fresh') {
        const entry = HashMap.unsafeGet(cache.entries, dirRel);
        // eslint-disable-next-line functional/no-loop-statements
        for (const name of entry.trackedNames) {
          workdirSet.add(dirRel === '' ? name : `${dirRel}/${name}`);
        }
        // eslint-disable-next-line functional/no-loop-statements
        for (const u of entry.untracked) {
          const rel = dirRel === '' ? u.name : `${dirRel}/${u.name}`;
          workdirSet.add(rel);
          untracked.set(rel, u.status);
        }
      }
    }
    // Stale dirs walked concurrently. Their results merge over the fresh
    // contributions — but a stale dir was excluded above, so there's no
    // collision.
    const staleDirs = checks.filter(([, s]) => s.kind === 'stale').map(([d]) => d);
    const staleResults = yield* Effect.forEach(staleDirs, (d) => walkStaleDir(cfg.dir, d, excludeContent), {
      concurrency: cfg.fdPermits,
    });
    // eslint-disable-next-line functional/no-loop-statements
    for (const r of staleResults) {
      if (r === null) continue;
      // eslint-disable-next-line functional/no-loop-statements
      for (const v of r.workdirSet) workdirSet.add(v);
      // eslint-disable-next-line functional/no-loop-statements
      for (const [k, v] of r.untracked) untracked.set(k, v);
    }
    return { workdirSet, untracked };
  });

/**
 * Warm statusMatrix entry point.
 *
 * Pre-conditions verified by the caller:
 * - `untrEnabled === true` (probe passed and capability is set).
 * - `cacheRef` has been refreshed against the on-disk sidecar's mtime.
 *
 * If `info/exclude`'s mtime has drifted from `cache.excludeMtimeMs`,
 * returns `{ kind: 'invalidated' }`. The caller falls back to cold and
 * rebuilds. No partial use of an invalidated cache.
 */
export const warm = Effect.fn('statusMatrixWarm')(function* (cfg: SwitchCfg, cache: UntrCache) {
  const excludeMtimeMs = yield* infoExcludeMtime(cfg.gitdir);
  if (excludeMtimeMs !== cache.excludeMtimeMs) {
    yield* Effect.annotateCurrentSpan({ outcome: 'invalidated', reason: 'exclude-mtime' });
    return { kind: 'invalidated', reason: 'exclude-mtime' } satisfies WarmOutcome;
  }

  const idx = yield* readIndex(cfg.gitdir);
  const indexByPath = new Map(idx.entries.map((e) => [e.path, e] as const));
  const headByPath = new Map(
    yield* streamHeadTree(cfg.gitdir).pipe(
      Stream.map((p) => [p.path, p.oid] as const),
      Stream.runCollect,
      Effect.map((c): ReadonlyArray<readonly [string, Oid]> => Array.from(c))
    )
  );

  const excludeContent = yield* readInfoExclude(cfg.gitdir);
  const fromCache = yield* collectFromCache(cfg, cache, excludeContent);

  // Tracked files that the cache didn't see in the workdir (e.g. cached
  // before applyChanges added them) are still tracked; cellHashing /
  // cellPure handle the "tracked but not in workdir" branch as 'deleted'
  // when missing. We layer index-derived dir → name groups onto the
  // workdir set as a sanity layer: for any tracked file whose dir is
  // present but the name isn't in workdirSet, leave it as such (cellPure
  // will emit 'deleted'). No work to do here.
  // The bare-file root case: when cfg.roots includes a single-file
  // path not under any walked directory, it must be in workdirSet too.
  const fileRootSet = yield* collectBareFileRoots(cfg.dir, cfg.roots);
  const workdirSet = new Set([...fromCache.workdirSet, ...fileRootSet]);
  const untracked = new Map(fromCache.untracked);
  // eslint-disable-next-line functional/no-loop-statements
  for (const rel of fileRootSet) {
    if (!indexByPath.has(rel) && !untracked.has(rel)) untracked.set(rel, 'added');
  }

  const cells = yield* evaluateMatrix(cfg, headByPath, indexByPath, workdirSet, untracked as UntrackedClassification);
  yield* Effect.annotateCurrentSpan({
    outcome: 'ok',
    cachedDirs: HashMap.size(cache.entries),
    workdirSetSize: workdirSet.size,
  });
  return { kind: 'ok', entries: cells } satisfies WarmOutcome;
});

/**
 * Convenience: helper that the wiring-layer can call with a loaded
 * `LoadedUntrCache`. Identical to `warm` for now; placeholder for
 * cross-process invalidation logic the wiring layer will add.
 */
export const warmFromLoaded = (cfg: SwitchCfg, loaded: LoadedUntrCache) => warm(cfg, loaded.cache);

// Re-export for the wiring layer (Repo) to feed buildUntrCache.
export { trackedByDir };
