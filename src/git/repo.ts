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
import * as ExecutionStrategy from 'effect/ExecutionStrategy';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { applyChanges as applyChangesImpl } from './applyChanges';
import { CapabilitiesTag, type Capabilities } from './capabilities';
import { ObjectCorruptError, RepoNotConfiguredError, WorkdirIoError } from './errors';
import { init as initImpl } from './init';
import { readIndex } from './indexV2';
import { hashBlob as hashBlobImpl, readLooseObject } from './objects';
import { resolveRef as resolveRefImpl } from './refs';
import { type Author, type Oid, type RefName, type RepoPath, type SwitchCfg } from './schemas';
import { cold as coldStatus } from './statusMatrix';
import { warm as warmStatus, type WarmOutcome } from './statusMatrixWarm';
import { streamHeadTree as streamHeadTreeImpl } from './trees';
import { buildUntrCache, trackedByDir } from './untrBuild';
import { type LoadedUntrCache, deleteUntrCache, readUntrCache, writeUntrCache } from './untrCache';
import { probeUntr } from './untrProbe';

/**
 * One swappable handle. `internals` is the slot phases 2+ extend (Effect.Cache,
 * `ignore` matcher, fd semaphore, UNTR-disabled flag). Phase 1 keeps it empty
 * so the lifecycle is testable in isolation.
 */
type RepoHandle = {
  readonly cfg: SwitchCfg;
  readonly capabilities: Capabilities;
  readonly internals: {
    /** True iff the active fs supports UNTR (probe passed AND capability says so). */
    readonly untrEnabled: boolean;
    /**
     * In-process loaded cache, gated on the on-disk sidecar's mtime. None
     * until the first warm `getStatus`; populated lazily after the first
     * load and thereafter refreshed when the disk sidecar's mtime advances
     * past `mtimeMs`.
     */
    readonly cacheRef: Ref.Ref<Option.Option<LoadedUntrCache>>;
  };
  readonly scope: Scope.CloseableScope;
};

type ApplyChangesArgs = {
  readonly adds: Stream.Stream<RepoPath>;
  readonly removes: Stream.Stream<RepoPath>;
  readonly message: string;
  readonly author: Author;
};

const notConfigured = (op: string): RepoNotConfiguredError =>
  new RepoNotConfiguredError({
    message: `Repo.${op} called before switchTo; pass a SwitchCfg first`,
  });

const requireHandle = (handleRef: Ref.Ref<Option.Option<RepoHandle>>, op: string) =>
  Ref.get(handleRef).pipe(
    Effect.flatMap((maybe) =>
      Option.match(maybe, {
        onNone: () => Effect.fail(notConfigured(op)),
        onSome: (h) => Effect.succeed(h),
      })
    )
  );

const buildHandle = (cfg: SwitchCfg, capabilities: Capabilities, untrEnabled: boolean, serviceScope: Scope.Scope) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(serviceScope, ExecutionStrategy.sequential);
    const cacheRef = yield* Ref.make<Option.Option<LoadedUntrCache>>(Option.none());
    return {
      cfg,
      capabilities,
      internals: { untrEnabled, cacheRef },
      scope,
    } satisfies RepoHandle;
  });

/**
 * The Repo service. One swappable handle, no multi-org. Methods that need
 * the handle fail with RepoNotConfiguredError pre-switchTo.
 */
export class Repo extends Effect.Service<Repo>()('@source-tracking/Repo', {
  scoped: Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const capabilities = yield* CapabilitiesTag;
    const serviceScope = yield* Effect.scope;

    const handleRef = yield* Ref.make<Option.Option<RepoHandle>>(Option.none());
    const swapSemaphore = yield* Effect.makeSemaphore(1);

    const provideFsAndPath = <A, E, R>(eff: Effect.Effect<A, E, R | FileSystem | Path>) =>
      eff.pipe(Effect.provideService(FileSystem, fs), Effect.provideService(Path, path));

    const provideFsAndPathStream = <A, E, R>(stream: Stream.Stream<A, E, R | FileSystem | Path>) =>
      stream.pipe(Stream.provideService(FileSystem, fs), Stream.provideService(Path, path));

    /**
     * Atomic publish + prior-scope close. The semaphore serializes
     * concurrent switchTo calls; in-flight operations against the prior
     * handle hold their own reference (captured at op entry) and so keep
     * the prior scope alive until they complete.
     */
    const switchTo = Effect.fn('Repo.switchTo')(function* (cfg: SwitchCfg) {
      yield* swapSemaphore.withPermits(1)(
        Effect.gen(function* () {
          // First-switch UNTR probe per phase 11. The probe result decides
          // `untrEnabled` for the handle; failure means warm is skipped
          // for this gitdir's lifetime.
          const probed = capabilities.supportsUntr
            ? yield* provideFsAndPath(
                probeUntr(cfg.gitdir).pipe(
                  Effect.catchAll(() => Effect.succeed({ kind: 'failed' as const, reason: 'unstable_ino' as const }))
                )
              )
            : ({ kind: 'failed', reason: 'unstable_ino' } as const);
          if (probed.kind === 'failed') {
            yield* Effect.logTrace(`untr probe failed for ${cfg.gitdir}: ${probed.reason}`);
          }
          const untrEnabled = capabilities.supportsUntr && probed.kind === 'ok';
          const next = yield* buildHandle(cfg, capabilities, untrEnabled, serviceScope);
          const prior = yield* Ref.getAndSet(handleRef, Option.some(next));
          yield* Option.match(prior, {
            onNone: () => Effect.void,
            onSome: (h) => Scope.close(h.scope, Exit.void),
          });
        })
      );
    });

    const init = Effect.fn('Repo.init')(function* (cfg: SwitchCfg) {
      yield* provideFsAndPath(initImpl({ cfg }).pipe(Effect.provideService(CapabilitiesTag, capabilities)));
      yield* switchTo(cfg);
    });

    /**
     * Refresh the in-process cacheRef if the on-disk sidecar's mtime has
     * advanced since we last loaded. Returns the loaded cache, or None if
     * the sidecar is missing / corrupt / decode-failed.
     */
    const ensureFreshCacheRef = Effect.fn('Repo.ensureFreshCacheRef')(function* (h: RepoHandle) {
      const current = yield* Ref.get(h.internals.cacheRef);
      const fresh = yield* readUntrCache(h.cfg.gitdir);
      if (Option.isNone(fresh)) {
        if (Option.isSome(current)) yield* Ref.set(h.internals.cacheRef, Option.none());
        return Option.none<LoadedUntrCache>();
      }
      const sameMtime = Option.match(current, {
        onNone: () => false,
        onSome: (c) => c.mtimeMs === fresh.value.mtimeMs,
      });
      if (sameMtime) return current;
      yield* Ref.set(h.internals.cacheRef, fresh);
      return fresh;
    });

    /**
     * Warm-or-fall-back-to-cold orchestration. Returns a list of
     * StatusEntry; the caller decides how to surface it (Stream vs array).
     *
     * If warm returns 'invalidated', delete the corrupt sidecar and clear
     * the in-process ref so the next applyChanges rebuilds from scratch.
     */
    const warmOrCold = Effect.fn('Repo.warmOrCold')(function* (h: RepoHandle) {
      if (!h.internals.untrEnabled) {
        return Array.from(yield* provideFsAndPath(coldStatus(h.cfg).pipe(Stream.runCollect)));
      }
      const loaded = yield* provideFsAndPath(ensureFreshCacheRef(h));
      if (Option.isNone(loaded)) {
        return Array.from(yield* provideFsAndPath(coldStatus(h.cfg).pipe(Stream.runCollect)));
      }
      const outcome: WarmOutcome = yield* provideFsAndPath(warmStatus(h.cfg, loaded.value.cache));
      if (outcome.kind === 'invalidated') {
        // Drop the corrupt slice — disk + in-process. Cold will rebuild
        // on next applyChanges.
        yield* Ref.set(h.internals.cacheRef, Option.none());
        yield* provideFsAndPath(deleteUntrCache(h.cfg.gitdir));
        return Array.from(yield* provideFsAndPath(coldStatus(h.cfg).pipe(Stream.runCollect)));
      }
      return [...outcome.entries];
    });

    const statusMatrix = () =>
      Stream.unwrap(
        requireHandle(handleRef, 'statusMatrix').pipe(Effect.map((h) => Stream.fromIterableEffect(warmOrCold(h))))
      );

    const collectStatus = Effect.fn('Repo.collectStatus')(function* () {
      const h = yield* requireHandle(handleRef, 'collectStatus');
      return yield* warmOrCold(h);
    });

    const applyChanges = Effect.fn('Repo.applyChanges')(function* (args: ApplyChangesArgs) {
      const h = yield* requireHandle(handleRef, 'applyChanges');
      const commitOid = yield* provideFsAndPath(
        applyChangesImpl({
          cfg: { dir: h.cfg.dir, gitdir: h.cfg.gitdir },
          adds: args.adds,
          removes: args.removes,
          message: args.message,
          author: args.author,
          addConcurrency: h.cfg.fdPermits,
        })
      );
      // After commit lands, rebuild + persist the UNTR cache. The
      // applyChanges critical section already serialized writers via
      // withIndexLock, but rebuild after release is acceptable: another
      // process between release and rebuild would either also rebuild
      // (concurrency-safe — each fully rewrites) or invalidate via
      // sidecar mtime check on its next getStatus.
      if (h.internals.untrEnabled) {
        yield* provideFsAndPath(rebuildAndStoreCache(h));
      }
      return commitOid;
    });

    const rebuildAndStoreCache = Effect.fn('Repo.rebuildUntr')(function* (h: RepoHandle) {
      const idx = yield* readIndex(h.cfg.gitdir);
      const cache = yield* buildUntrCache(h.cfg, trackedByDir(idx.entries));
      yield* writeUntrCache(h.cfg.gitdir, cache);
      // Re-read so we capture the on-disk sidecar's mtime; the in-process
      // ref's mtime must match disk for cross-process invalidation to
      // remain correct.
      const loaded = yield* readUntrCache(h.cfg.gitdir);
      yield* Ref.set(h.internals.cacheRef, loaded);
    });

    const hashBlob = (bytes: Uint8Array) => hashBlobImpl(bytes);

    const readBlob = Effect.fn('Repo.readBlob')(function* (oid: Oid) {
      const h = yield* requireHandle(handleRef, 'readBlob');
      const obj = yield* provideFsAndPath(readLooseObject(h.cfg.gitdir, oid));
      return obj.type === 'blob'
        ? obj.content
        : yield* Effect.fail(
            new ObjectCorruptError({
              oid,
              reason: `expected blob, got ${obj.type}`,
              message: `Repo.readBlob ${oid}: not a blob`,
            })
          );
    });

    const resolveRef = Effect.fn('Repo.resolveRef')(function* (ref: RefName) {
      const h = yield* requireHandle(handleRef, 'resolveRef');
      return yield* provideFsAndPath(resolveRefImpl(h.cfg.gitdir, ref));
    });

    const streamHeadTree = () =>
      Stream.unwrap(
        requireHandle(handleRef, 'streamHeadTree').pipe(
          Effect.map((h) => provideFsAndPathStream(streamHeadTreeImpl(h.cfg.gitdir)))
        )
      );

    const setInfoExclude = Effect.fn('Repo.setInfoExclude')(function* (content: string) {
      const h = yield* requireHandle(handleRef, 'setInfoExclude');
      yield* Effect.annotateCurrentSpan('byteLength', content.length);
      const dir = path.join(h.cfg.gitdir, 'info');
      const file = path.join(dir, 'exclude');
      yield* fs
        .makeDirectory(dir, { recursive: true })
        .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(dir, cause))));
      yield* fs
        .writeFileString(file, content)
        .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(file, cause))));
    });

    return {
      init,
      switchTo,
      statusMatrix,
      collectStatus,
      applyChanges,
      hashBlob,
      readBlob,
      resolveRef,
      streamHeadTree,
      setInfoExclude,
    };
  }),
  dependencies: [],
}) {}
