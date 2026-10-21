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

import path from 'node:path';
import { Lifecycle, Logger } from '@salesforce/core';
import { FileSystem, type FileSystem as FileSystemService } from 'effect/FileSystem';
import { type Path } from 'effect/Path';
import type { Crypto } from 'effect/Crypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as Effect from 'effect/Effect';
import * as Chunk from 'effect/Chunk';
import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as HashSet from 'effect/HashSet';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { type RepoError } from '../../git/errors.js';
import { Repo } from '../../git/repo.js';
import { repoErrorToSfError } from '../../git/sfCompatibility.js';
import {
  Author as AuthorSchema,
  RepoPath as RepoPathSchema,
  type RepoPath,
  SwitchCfg as SwitchCfgSchema,
} from '../../git/schemas.js';
import { excludeLwcLocalOnlyTest, folderContainsPath } from '../functions.js';
import { getMatches, ensurePosix, IS_WINDOWS } from './functions.js';
import { filenameMatchesToMap } from './moveDetection.js';
import type { LocalChanges, ShadowRepoOptions, SyncRequest } from './types.js';

const getGitDir = (orgId: string, projectPath: string): string =>
  path.join(projectPath, '.sf', 'orgs', orgId, 'localSourceTracking');

const SHADOW_AUTHOR = Schema.decodeUnknownSync(AuthorSchema)({
  name: 'sfdx source tracking',
  email: 'source-tracking@noreply.salesforce.com',
});

const EMPTY_CHANGES: LocalChanges = { added: [], modified: [], deleted: [] };

const FD_PERMITS_ENV = 'SF_SOURCE_TRACKING_FD_PERMITS';
const FD_PERMITS_FALLBACK = IS_WINDOWS ? 64 : 256;

const readNumberEnv = (name: string, fallback: number) =>
  Config.Number(name)
    .pipe(Config.withDefault(fallback))
    .parse(ConfigProvider.fromEnv())
    .pipe(Effect.catchTag('ConfigError', () => Effect.succeed(fallback)));

const readBooleanEnv = (name: string) =>
  Config.String(name)
    .pipe(
      Config.withDefault('false'),
      Config.map((value) => value.toLowerCase() === 'true' || value === '1')
    )
    .parse(ConfigProvider.fromEnv())
    .pipe(Effect.catchTag('ConfigError', () => Effect.succeed(false)));

const buildExclude = (packageDirs: string[]): string =>
  // .git/info/exclude is gitignore-syntax. Lite's status walk also applies the
  // package-root and Salesforce-specific exclusions in liteFileFilter below.
  [
    '# Written by sfdx source-tracking; do not edit by hand.',
    '*/.*/**',
    '.*',
    '*/node_modules/**',
    'node_modules/**',
    '*.gitignore',
    '',
    '# package roots:',
    ...packageDirs.map((p) => `# ${p}`),
  ].join('\n');

const liteFileFilter =
  (packageDirs: string[]) =>
  (file: string): boolean =>
    !file.includes('/.') &&
    !file.split('/').includes('node_modules') &&
    excludeLwcLocalOnlyTest(file) &&
    !file.endsWith('.gitignore') &&
    packageDirs.some(folderContainsPath(file));

type ShadowRepoEffects = {
  readonly gitDir: string;
  readonly projectPath: string;
  readonly getStatus: (
    refresh?: boolean
  ) => Effect.Effect<LocalChanges, RepoError, Repo | FileSystemService | Path | Crypto>;
  readonly recordSync: (
    request?: SyncRequest
  ) => Effect.Effect<string, RepoError, Repo | FileSystemService | Path | Crypto>;
  readonly delete: () => Effect.Effect<string, RepoError, Repo | FileSystemService | Path>;
};

type ApplyChangesArgs = {
  readonly deployedFiles: Iterable<string>;
  readonly deletedFiles: Iterable<string>;
  readonly deployedCount: number;
  readonly deletedCount: number;
  readonly message?: string;
};

/** Build one org's local-tracking operations. Git state and the status cache live in this closure. */
const makeShadowRepo = Effect.fn('ShadowRepo.make')(function* (options: ShadowRepoOptions, logger: Logger) {
  const repo = yield* Repo;
  const fs = yield* FileSystem;
  const fdPermits = yield* readNumberEnv(FD_PERMITS_ENV, FD_PERMITS_FALLBACK);
  const gitDir = getGitDir(options.orgId, options.projectPath);
  const packageDirs = options.packageDirs.map((d) => {
    const relative = path.relative(options.projectPath, d.fullPath);
    return IS_WINDOWS ? ensurePosix(relative) : relative;
  });
  const fileFilter = liteFileFilter(packageDirs);
  const roots = packageDirs.map((p) => Schema.decodeUnknownSync(RepoPathSchema)(p));
  const cfg = Schema.decodeUnknownSync(SwitchCfgSchema)({
    dir: options.projectPath,
    gitdir: gitDir,
    roots,
    fdPermits,
  });
  const statusCache = yield* Ref.make<Option.Option<LocalChanges>>(Option.none());

  const scanStatus = Effect.fnUntraced(function* () {
    const changes = yield* repo.statusMatrix().pipe(
      Stream.filter((entry) => fileFilter(entry.path)),
      Stream.runFold(
        () => ({
          added: Chunk.empty<string>(),
          modified: Chunk.empty<string>(),
          deleted: Chunk.empty<string>(),
        }),
        (current, entry) => {
          const file = IS_WINDOWS ? path.normalize(entry.path) : entry.path;
          return Match.value(entry.status).pipe(
            Match.when('added', () => ({ ...current, added: Chunk.append(current.added, file) })),
            Match.when('modified', () => ({ ...current, modified: Chunk.append(current.modified, file) })),
            Match.when('deleted', () => ({ ...current, deleted: Chunk.append(current.deleted, file) })),
            Match.whenOr('unmodified', 'ignored', () => current),
            Match.exhaustive
          );
        }
      )
    );
    return {
      added: Chunk.toReadonlyArray(changes.added),
      modified: Chunk.toReadonlyArray(changes.modified),
      deleted: Chunk.toReadonlyArray(changes.deleted),
    };
  });

  const applyChanges = Effect.fn('ShadowRepo.applyChanges')(function* ({
    deployedFiles,
    deletedFiles,
    deployedCount,
    deletedCount,
    message = 'sfdx source tracking',
  }: ApplyChangesArgs) {
    if (deployedCount === 0 && deletedCount === 0) return 'no files to commit';

    const toRepoPath = (file: string): RepoPath =>
      Schema.decodeUnknownSync(RepoPathSchema)(IS_WINDOWS ? ensurePosix(file) : file);
    const adds = Stream.fromIterable(deployedFiles).pipe(Stream.map(toRepoPath));
    const removes = Stream.fromIterable(deletedFiles).pipe(Stream.map(toRepoPath));
    yield* Effect.annotateCurrentSpan({ deployedCount, deletedCount });
    return yield* repo.applyChanges({ adds, removes, message, author: SHADOW_AUTHOR });
  });

  const detectMovedFiles = Effect.fn('ShadowRepo.detectMovedFiles')(function* (changes: LocalChanges) {
    const matchingFiles = getMatches(changes);
    yield* Effect.annotateCurrentSpan({
      addedCount: HashSet.size(matchingFiles.added),
      deletedCount: HashSet.size(matchingFiles.deleted),
    });
    if (HashSet.isEmpty(matchingFiles.added) || HashSet.isEmpty(matchingFiles.deleted)) return false;

    const result = yield* filenameMatchesToMap(options.registry)(options.projectPath)(fdPermits)(matchingFiles);
    yield* Effect.annotateCurrentSpan({ moveCount: result.count });
    if (result.count === 0) return false;

    yield* Effect.sync(() => logger.debug(result.logMessage));
    yield* applyChanges({
      deployedFiles: result.deployedFiles,
      deletedFiles: result.deletedFiles,
      deployedCount: Chunk.size(result.deployedFiles),
      deletedCount: Chunk.size(result.deletedFiles),
      message: 'Committing moved files',
    });
    return true;
  });

  const refreshStatus = Effect.fn('ShadowRepo.refreshStatus')(function* () {
    const changes = yield* scanStatus();
    // Keep the first scan cached if move detection fails, matching the old
    // behavior: a later non-forced read does not repeat a failed detection.
    yield* Ref.set(statusCache, Option.some(changes));

    const movesDisabled = yield* readBooleanEnv('SF_DISABLE_SOURCE_MOBILITY');
    yield* Effect.promise(() =>
      Lifecycle.getInstance().emitTelemetry({
        eventName: movesDisabled ? 'moveFileDetectionDisabled' : 'moveFileDetectionEnabled',
      })
    );

    const moved = yield* movesDisabled ? Effect.succeed(false) : detectMovedFiles(changes);
    const finalChanges = moved ? yield* scanStatus() : changes;
    yield* Ref.set(statusCache, Option.some(finalChanges));
    yield* Effect.annotateCurrentSpan({
      addedCount: finalChanges.added.length,
      modifiedCount: finalChanges.modified.length,
      deletedCount: finalChanges.deleted.length,
    });
    return finalChanges;
  });

  const getStatus = Effect.fn('ShadowRepo.getStatus')(function* (refresh = false) {
    yield* Effect.sync(() => logger.trace(`lite start: getStatus (refresh = ${refresh})`));
    const cached = yield* Ref.get(statusCache);
    if (yield* readBooleanEnv('SF_SOURCE_TRACKING_ASSUME_SYNCED')) {
      const shouldWarn =
        Option.isNone(cached) ||
        cached.value.added.length + cached.value.modified.length + cached.value.deleted.length > 0;
      if (shouldWarn) {
        yield* Effect.sync(() =>
          logger.warn(
            'SF_SOURCE_TRACKING_ASSUME_SYNCED is set. Skipping local status check and assuming local files match the shadow repo.'
          )
        );
        yield* Effect.promise(() => Lifecycle.getInstance().emitTelemetry({ eventName: 'sourceTrackingAssumeSynced' }));
      }
      yield* Ref.set(statusCache, Option.some(EMPTY_CHANGES));
      return EMPTY_CHANGES;
    }
    const changes = !refresh && Option.isSome(cached) ? cached.value : yield* refreshStatus();
    yield* Effect.sync(() =>
      logger.trace(
        `lite done: getStatus (changeCount = ${
          changes.added.length + changes.modified.length + changes.deleted.length
        })`
      )
    );
    return changes;
  });

  const recordSync = Effect.fn('ShadowRepo.recordSync')(function* (request: SyncRequest = {}) {
    const hasFiles = (request.deployedFiles?.length ?? 0) > 0 || (request.deletedFiles?.length ?? 0) > 0;
    const deployedFiles = request.deployedFiles ?? [];
    const deletedFiles = request.deletedFiles ?? [];
    const result = yield* applyChanges({
      deployedFiles,
      deletedFiles,
      deployedCount: deployedFiles.length,
      deletedCount: deletedFiles.length,
      message: request.message,
    });
    if (hasFiles && request.needsUpdatedStatus !== false) {
      yield* refreshStatus();
    }
    return result;
  });

  const deleteShadowRepo = Effect.fn('ShadowRepo.delete')(function* () {
    yield* fs.remove(gitDir, { recursive: true, force: true });
    yield* Ref.set(statusCache, Option.none());
    return gitDir;
  });

  // init is idempotent for a valid repo and initializes an existing empty
  // directory. Merely switching on fs.exists could select a partial gitdir.
  yield* repo.init(cfg);
  yield* repo.setInfoExclude(buildExclude(packageDirs));

  return {
    gitDir,
    projectPath: options.projectPath,
    getStatus,
    recordSync,
    delete: deleteShadowRepo,
  } satisfies ShadowRepoEffects;
});

export type ShadowRepo = {
  readonly gitDir: string;
  readonly projectPath: string;
  getStatus: (refresh?: boolean) => Promise<LocalChanges>;
  getChangedFilenames: () => Promise<string[]>;
  getDeleteFilenames: () => Promise<string[]>;
  getNonDeleteFilenames: () => Promise<string[]>;
  getAddFilenames: () => Promise<string[]>;
  getModifyFilenames: () => Promise<string[]>;
  recordSync: (request?: SyncRequest) => Promise<string>;
  delete: () => Promise<string>;
};

type ShadowRepoRuntime = ManagedRuntime.ManagedRuntime<Repo | FileSystemService | Path | Crypto, never>;

const runEffect = <A>(
  runtime: ShadowRepoRuntime,
  logger: Logger,
  operation: string,
  effect: Effect.Effect<A, RepoError, Repo | FileSystemService | Path | Crypto>
): Promise<A> =>
  runtime.runPromise(
    effect.pipe(
      Effect.tapError((error) => Effect.sync(() => logger.debug(`ShadowRepo.${operation} failed: ${error.message}`))),
      Effect.mapError(repoErrorToSfError)
    )
  );

/** Promise adapter for SourceTracking and CLI callers; the implementation above stays Effect-native. */
export const createShadowRepo = async (options: ShadowRepoOptions): Promise<ShadowRepo> => {
  const logger = await Logger.child('ShadowRepo');
  const baseLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, options.cryptoLayer ?? NodeCrypto.layer);
  const repoLayer = Layer.provide(Repo.layer, baseLayer);
  const runtime = ManagedRuntime.make(Layer.mergeAll(repoLayer, baseLayer));
  const effects = await runEffect(runtime, logger, 'init', makeShadowRepo(options, logger));
  const getStatus = (refresh = false): Promise<LocalChanges> =>
    runEffect(runtime, logger, 'getStatus', effects.getStatus(refresh));

  return {
    gitDir: effects.gitDir,
    projectPath: effects.projectPath,
    getStatus,
    getChangedFilenames: () =>
      getStatus().then((changes) => [...changes.added, ...changes.modified, ...changes.deleted]),
    getDeleteFilenames: () => getStatus().then((changes) => Array.from(changes.deleted)),
    getNonDeleteFilenames: () => getStatus().then((changes) => [...changes.added, ...changes.modified]),
    getAddFilenames: () => getStatus().then((changes) => Array.from(changes.added)),
    getModifyFilenames: () => getStatus().then((changes) => Array.from(changes.modified)),
    recordSync: (request) => runEffect(runtime, logger, 'recordSync', effects.recordSync(request)),
    delete: () => runEffect(runtime, logger, 'delete', effects.delete()),
  };
};
