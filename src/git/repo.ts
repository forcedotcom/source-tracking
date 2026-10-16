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
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Semaphore from 'effect/Semaphore';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { applyChanges as applyChangesImpl } from './applyChanges.js';
import { ObjectCorruptError, RepoNotConfiguredError, WorkdirIoError } from './errors.js';
import { init as initImpl } from './init.js';
import { hashBlob as hashBlobImpl, readLooseObject } from './objects.js';
import { resolveRef as resolveRefImpl } from './refs.js';
import { type Author, type Oid, type RefName, type RepoPath, type SwitchCfg } from './schemas.js';
import { cold as coldStatus } from './statusMatrix.js';
import { streamHeadTree as streamHeadTreeImpl } from './trees.js';

/**
 * One swappable handle. Each operation captures the active config before
 * asynchronous work starts, so a later switch cannot redirect it.
 */
type RepoHandle = {
  readonly cfg: SwitchCfg;
  readonly scope: Scope.Closeable;
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

const buildHandle = (cfg: SwitchCfg, serviceScope: Scope.Scope) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(serviceScope, 'sequential');
    return {
      cfg,
      scope,
    } satisfies RepoHandle;
  });

/**
 * The Repo service. One swappable handle, no multi-org. Methods that need
 * the handle fail with RepoNotConfiguredError pre-switchTo.
 */
const makeRepo = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const serviceScope = yield* Effect.scope;

  const handleRef = yield* Ref.make<Option.Option<RepoHandle>>(Option.none());
  const swapSemaphore = yield* Semaphore.make(1);

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
    yield* Semaphore.withPermits(
      swapSemaphore,
      1
    )(
      Effect.gen(function* () {
        const next = yield* buildHandle(cfg, serviceScope);
        const prior = yield* Ref.getAndSet(handleRef, Option.some(next));
        yield* Option.match(prior, {
          onNone: () => Effect.void,
          onSome: (h) => Scope.close(h.scope, Exit.void),
        });
      })
    );
  });

  const init = Effect.fn('Repo.init')(function* (cfg: SwitchCfg) {
    yield* provideFsAndPath(initImpl({ cfg }));
    yield* switchTo(cfg);
  });

  const statusMatrix = () =>
    Stream.unwrap(
      requireHandle(handleRef, 'statusMatrix').pipe(Effect.map((h) => provideFsAndPathStream(coldStatus(h.cfg))))
    );

  const collectStatus = Effect.fn('Repo.collectStatus')(function* () {
    const h = yield* requireHandle(handleRef, 'collectStatus');
    return Array.from(yield* provideFsAndPath(coldStatus(h.cfg).pipe(Stream.runCollect)));
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
    return commitOid;
  });

  const hashBlob = (bytes: Uint8Array) => hashBlobImpl(bytes);

  const readBlob = Effect.fn('Repo.readBlob')(function* (oid: Oid) {
    const h = yield* requireHandle(handleRef, 'readBlob');
    const obj = yield* provideFsAndPath(readLooseObject(h.cfg.gitdir, oid));
    return obj.type === 'blob'
      ? obj.content
      : yield* new ObjectCorruptError({
          oid,
          reason: `expected blob, got ${obj.type}`,
          message: `Repo.readBlob ${oid}: not a blob`,
        });
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
      .pipe(Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(dir, cause))));
    yield* fs
      .writeFileString(file, content)
      .pipe(Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(file, cause))));
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
});

/** @internal */
export class Repo extends Context.Service<Repo, Effect.Success<typeof makeRepo>>()(
  '@salesforce/source-tracking/git/repo'
) {
  public static readonly layer = Layer.effect(Repo, makeRepo);
}
