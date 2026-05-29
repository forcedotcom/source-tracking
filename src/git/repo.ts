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
import * as Stream from 'effect/Stream';
import * as Ref from 'effect/Ref';
import * as Option from 'effect/Option';
import * as Scope from 'effect/Scope';
import * as ExecutionStrategy from 'effect/ExecutionStrategy';
import * as Exit from 'effect/Exit';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { CapabilitiesTag, type Capabilities } from './capabilities';
import {
  ObjectCorruptError,
  RepoNotConfiguredError,
  type IndexCorruptError,
  type ObjectNotFoundError,
  type RefNotFoundError,
  type RepoError,
  type WorkdirIoError,
} from './errors';
import { init as initImpl } from './init';
import { hashBlob as hashBlobImpl, readLooseObject } from './objects';
import { resolveRef as resolveRefImpl } from './refs';
import {
  type Author,
  type CommitOid,
  type Oid,
  type RefName,
  type RepoPath,
  type StatusEntry,
  type SwitchCfg,
} from './schemas';

/**
 * One swappable handle. `internals` is the slot phases 2+ extend (Effect.Cache,
 * `ignore` matcher, fd semaphore, UNTR-disabled flag). Phase 1 keeps it empty
 * so the lifecycle is testable in isolation.
 */
export type RepoHandle = {
  readonly cfg: SwitchCfg;
  readonly capabilities: Capabilities;
  readonly internals: Readonly<Record<string, unknown>>;
  readonly scope: Scope.CloseableScope;
};

const notConfigured = (op: string): RepoNotConfiguredError =>
  new RepoNotConfiguredError({
    message: `Repo.${op} called before switchTo; pass a SwitchCfg first`,
  });

const requireHandle = (
  handleRef: Ref.Ref<Option.Option<RepoHandle>>,
  op: string
): Effect.Effect<RepoHandle, RepoNotConfiguredError> =>
  Ref.get(handleRef).pipe(
    Effect.flatMap((maybe) =>
      Option.match(maybe, {
        onNone: () => Effect.fail(notConfigured(op)),
        onSome: (h) => Effect.succeed(h),
      })
    )
  );

const notImplemented = (op: string): Effect.Effect<never> =>
  Effect.die(new Error(`Repo.${op}: not implemented (phase scaffolding only)`));

/**
 * Build a fresh handle in its own forked child scope. Phase 1 is empty:
 * caches and matchers will register their finalizers on this inner scope
 * starting in phase 2.
 */
const buildHandle = (
  cfg: SwitchCfg,
  capabilities: Capabilities,
  serviceScope: Scope.Scope
): Effect.Effect<RepoHandle> =>
  Scope.fork(serviceScope, ExecutionStrategy.sequential).pipe(
    Effect.map((scope) => ({
      cfg,
      capabilities,
      internals: Object.freeze({}),
      scope,
    }))
  );

/**
 * The Repo service. One swappable handle, no multi-org. Methods that need
 * the handle fail with RepoNotConfiguredError pre-switchTo; everything else
 * dies with "not implemented" until the relevant phase lands.
 */
export class Repo extends Effect.Service<Repo>()('@source-tracking/Repo', {
  scoped: Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const capabilities = yield* CapabilitiesTag;
    const serviceScope = yield* Effect.scope;

    const handleRef = yield* Ref.make<Option.Option<RepoHandle>>(Option.none());
    const swapSemaphore = yield* Effect.makeSemaphore(1);

    /**
     * Atomic publish + prior-scope close. The semaphore serializes
     * concurrent switchTo calls; in-flight operations against the prior
     * handle hold their own reference to it (captured at op entry) and so
     * keep the prior scope alive until they complete.
     */
    const switchTo = Effect.fn('Repo.switchTo')(function* (cfg: SwitchCfg) {
      yield* swapSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* buildHandle(cfg, capabilities, serviceScope);
          const prior = yield* Ref.getAndSet(handleRef, Option.some(next));
          yield* Option.match(prior, {
            onNone: () => Effect.void,
            onSome: (h) => Scope.close(h.scope, Exit.void),
          });
        })
      );
    });

    const init = (cfg: SwitchCfg): Effect.Effect<void, IndexCorruptError | WorkdirIoError | RepoNotConfiguredError> =>
      initImpl({ cfg }).pipe(
        Effect.provideService(FileSystem, fs),
        Effect.provideService(Path, path),
        Effect.provideService(CapabilitiesTag, capabilities),
        Effect.flatMap(() => switchTo(cfg))
      );

    const statusMatrix = (): Stream.Stream<StatusEntry, RepoError> =>
      Stream.unwrap(
        requireHandle(handleRef, 'statusMatrix').pipe(
          Effect.map(() => Stream.fromEffect(notImplemented('statusMatrix')) as Stream.Stream<StatusEntry, RepoError>)
        )
      );

    const collectStatus = Effect.fn('Repo.collectStatus')(function* () {
      yield* requireHandle(handleRef, 'collectStatus');
      return yield* notImplemented('collectStatus');
    }) as () => Effect.Effect<readonly StatusEntry[], RepoError>;

    type ApplyChangesArgs = {
      readonly adds: Stream.Stream<RepoPath>;
      readonly removes: Stream.Stream<RepoPath>;
      readonly message: string;
      readonly author: Author;
    };

    const applyChanges = ((args: ApplyChangesArgs): Effect.Effect<CommitOid, RepoError> =>
      requireHandle(handleRef, 'applyChanges').pipe(
        Effect.tap(() => Effect.annotateCurrentSpan('argCount', Object.keys(args).length)),
        Effect.flatMap(() => notImplemented('applyChanges'))
      )) as (args: ApplyChangesArgs) => Effect.Effect<CommitOid, RepoError>;

    const hashBlob = (bytes: Uint8Array): Effect.Effect<Oid> => hashBlobImpl(bytes);

    const readBlob = (
      oid: Oid
    ): Effect.Effect<Uint8Array, ObjectNotFoundError | ObjectCorruptError | RepoNotConfiguredError> =>
      requireHandle(handleRef, 'readBlob').pipe(
        Effect.flatMap((h) =>
          readLooseObject(h.cfg.gitdir, oid).pipe(
            Effect.flatMap((obj) =>
              obj.type === 'blob'
                ? Effect.succeed(obj.content)
                : Effect.fail(
                    new ObjectCorruptError({
                      oid,
                      reason: `expected blob, got ${obj.type}`,
                      message: `Repo.readBlob ${oid}: not a blob`,
                    })
                  )
            ),
            Effect.provideService(FileSystem, fs),
            Effect.provideService(Path, path)
          )
        )
      );

    const resolveRef = (ref: RefName): Effect.Effect<Oid, RefNotFoundError | RepoNotConfiguredError | WorkdirIoError> =>
      requireHandle(handleRef, 'resolveRef').pipe(
        Effect.flatMap((h) =>
          resolveRefImpl(h.cfg.gitdir, ref).pipe(
            Effect.provideService(FileSystem, fs),
            Effect.provideService(Path, path)
          )
        )
      );

    const streamHeadTree = (): Stream.Stream<{ readonly path: RepoPath; readonly oid: Oid }, RepoError> =>
      Stream.unwrap(
        requireHandle(handleRef, 'streamHeadTree').pipe(
          Effect.map(
            () =>
              Stream.fromEffect(notImplemented('streamHeadTree')) as Stream.Stream<
                { readonly path: RepoPath; readonly oid: Oid },
                RepoError
              >
          )
        )
      );

    const setInfoExclude = ((content: string) =>
      requireHandle(handleRef, 'setInfoExclude').pipe(
        Effect.tap(() => Effect.annotateCurrentSpan('byteLength', content.length)),
        Effect.flatMap(() => notImplemented('setInfoExclude'))
      )) as (content: string) => Effect.Effect<void, WorkdirIoError | RepoNotConfiguredError | IndexCorruptError>;

    void fs;
    void path;

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
