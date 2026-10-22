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
import { Crypto } from 'effect/Crypto';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { applyChanges as applyChangesImpl } from './applyChanges.js';
import { ObjectCorruptError } from './errors.js';
import { init as initImpl } from './init.js';
import { hashBlob as hashBlobImpl, readLooseObject } from './objects.js';
import { resolveRef as resolveRefImpl } from './refs.js';
import { type Author, type Oid, type RefName, type RepoPath, type RepoConfig } from './schemas.js';
import { cold as coldStatus } from './statusMatrix.js';
import { streamHeadTree as streamHeadTreeImpl } from './trees.js';

type ApplyChangesArgs = {
  readonly adds: Stream.Stream<RepoPath>;
  readonly removes: Stream.Stream<RepoPath>;
  readonly message: string;
  readonly author: Author;
};

/** One repository configuration, with platform services retained for the layer's lifetime. */
const makeRepo = Effect.fn('Repo.make')(function* (cfg: RepoConfig) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const crypto = yield* Crypto;

  const provideGitServices = <A, E, R>(eff: Effect.Effect<A, E, R | FileSystem | Path | Crypto>) =>
    eff.pipe(
      Effect.provideService(FileSystem, fs),
      Effect.provideService(Path, path),
      Effect.provideService(Crypto, crypto)
    );

  const provideGitServicesStream = <A, E, R>(stream: Stream.Stream<A, E, R | FileSystem | Path | Crypto>) =>
    stream.pipe(
      Stream.provideService(FileSystem, fs),
      Stream.provideService(Path, path),
      Stream.provideService(Crypto, crypto)
    );

  const init = () => initImpl({ cfg }).pipe(provideGitServices);
  const statusMatrix = () => coldStatus(cfg).pipe(provideGitServicesStream);
  const applyChanges = (args: ApplyChangesArgs) =>
    applyChangesImpl({ cfg, ...args, addConcurrency: cfg.fdPermits }).pipe(provideGitServices);

  const readBlob = Effect.fn('Repo.readBlob')(function* (oid: Oid) {
    return yield* readLooseObject(cfg.gitdir, oid).pipe(
      provideGitServices,
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
      )
    );
  });

  const resolveRef = (ref: RefName) => resolveRefImpl(cfg.gitdir, ref).pipe(provideGitServices);
  const streamHeadTree = () => streamHeadTreeImpl(cfg.gitdir).pipe(provideGitServicesStream);

  const setInfoExclude = Effect.fn('Repo.setInfoExclude')(function* (content: string) {
    yield* Effect.annotateCurrentSpan('byteLength', content.length);
    const dir = path.join(cfg.gitdir, 'info');
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, 'exclude'), content);
  });

  return {
    init,
    statusMatrix,
    applyChanges,
    hashBlob: (bytes: Uint8Array) => provideGitServices(hashBlobImpl(bytes)),
    readBlob,
    resolveRef,
    streamHeadTree,
    setInfoExclude,
  };
});

/** @internal */
export class Repo extends Context.Service<Repo, Effect.Success<ReturnType<typeof makeRepo>>>()(
  '@salesforce/source-tracking/git/repo'
) {
  public static readonly layer = (cfg: RepoConfig) => Layer.effect(Repo, makeRepo(cfg));
}
