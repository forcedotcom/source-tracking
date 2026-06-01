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
import * as fs from 'graceful-fs';
import { Lifecycle, Logger } from '@salesforce/core';
import { env } from '@salesforce/kit';
import { type FileSystem } from '@effect/platform/FileSystem';
import { type Path } from '@effect/platform/Path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { NodeCapabilitiesLayer } from '../../git/capabilities';
import { type RepoError } from '../../git/errors';
import { Repo } from '../../git/repo';
import { repoErrorToSfError } from '../../git/sfCompatibility';
import { otelLayerOrEmpty } from '../runtime';
import {
  Author as AuthorSchema,
  RepoPath as RepoPathSchema,
  type RepoPath,
  type StatusEntry,
  SwitchCfg as SwitchCfgSchema,
} from '../../git/schemas';
import { excludeLwcLocalOnlyTest, folderContainsPath } from '../functions';
import { eventLoopDelayCapture } from '../eventLoopDelayCapture';
import { getMatches } from './moveDetection';
import { filenameMatchesToMapLite } from './moveDetectionLite';
import { CommitRequest, ShadowRepoLike, ShadowRepoOptions, StatusRow } from './types';
import { ensurePosix, IS_WINDOWS, isAdded, isDeleted, toFilenames } from './functions';

const getGitDir = (orgId: string, projectPath: string): string =>
  path.join(projectPath, '.sf', 'orgs', orgId, 'localSourceTracking');

const SHADOW_AUTHOR = Schema.decodeUnknownSync(AuthorSchema)({
  name: 'sfdx source tracking',
  email: 'source-tracking@noreply.salesforce.com',
});

/**
 * Map a 5-status StatusEntry from lite to the iso-git-shaped tuple
 * [file, head, workdir, stage] expected by callers. Stage is unused by
 * source-tracking (see `local/functions.ts`), so values are the iso-git
 * canonical mapping.
 */
const toStatusRow = (e: StatusEntry): StatusRow => {
  switch (e.status) {
    case 'unmodified':
      return [e.path, 1, 1, 1];
    case 'modified':
      return [e.path, 1, 2, 2];
    case 'added':
      return [e.path, 0, 2, 2];
    case 'deleted':
      return [e.path, 1, 0, 0];
    case 'ignored':
      return [e.path, 0, 0, 0];
  }
};

const FD_PERMITS_DEFAULT = env.getNumber('SF_SOURCE_TRACKING_FD_PERMITS', IS_WINDOWS ? 64 : 256);

const buildExclude = (packageDirs: string[]): string =>
  // .git/info/exclude is gitignore-syntax. Encode the same rules as iso's
  // fileFilter(): exclude hidden segments, node_modules, .gitignore files,
  // lwc test bundles. Lite's statusMatrix honors this via its `ignore`
  // matcher loaded in loadIgnoreMatcher.
  [
    '# Written by sfdx source-tracking; do not edit by hand.',
    '*/.*/**',
    '.*',
    '*/node_modules/**',
    'node_modules/**',
    '*.gitignore',
    // lwc localOnly test bundles: <pkgDir>/main/default/lwc/<bundle>/__tests__/...
    // gitignore can't express the regex, so leave to lite's fileFilter pass below.
    '',
    '# package roots:',
    ...packageDirs.map((p) => `# ${p}`),
  ].join('\n');

/** Mirror of iso's fileFilter() for the bits .gitignore can't express. */
const liteFileFilter =
  (packageDirs: string[]) =>
  (f: string): boolean =>
    !f.includes('/.') &&
    !f.split('/').includes('node_modules') &&
    excludeLwcLocalOnlyTest(f) &&
    !f.endsWith('.gitignore') &&
    packageDirs.some(folderContainsPath(f));

export class ShadowRepoLite implements ShadowRepoLike {
  private static instanceMap = new Map<string, ShadowRepoLite>();

  public gitDir: string;
  public projectPath: string;

  private packageDirs: string[];
  /** posix package dirs as branded RepoPath, used for cfg.roots */
  private rootsBranded: readonly RepoPath[];
  private status!: StatusRow[];
  private logger!: Logger;
  private runtime!: ManagedRuntime.ManagedRuntime<Repo | FileSystem | Path, never>;
  private readonly registry: ShadowRepoOptions['registry'];

  private constructor(options: ShadowRepoOptions) {
    this.gitDir = getGitDir(options.orgId, options.projectPath);
    this.projectPath = options.projectPath;
    this.packageDirs = options.packageDirs.map((d) => {
      const rel = path.relative(options.projectPath, d.fullPath);
      return IS_WINDOWS ? ensurePosix(rel) : rel;
    });
    this.rootsBranded = this.packageDirs.map((p) => Schema.decodeUnknownSync(RepoPathSchema)(p));
    this.registry = options.registry;
  }

  public static async getInstance(options: ShadowRepoOptions): Promise<ShadowRepoLite> {
    if (!ShadowRepoLite.instanceMap.has(options.projectPath)) {
      const inst = new ShadowRepoLite(options);
      await inst.init();
      ShadowRepoLite.instanceMap.set(options.projectPath, inst);
    }
    return ShadowRepoLite.instanceMap.get(options.projectPath) as ShadowRepoLite;
  }

  public async init(): Promise<void> {
    this.logger = await Logger.child('ShadowRepo');
    const baseLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCapabilitiesLayer);
    const repoLayer = Layer.provide(Repo.Default, baseLayer);
    // OTel layer (if STL_OTEL_SPANS=1) so traces inside lite operations
    // make it to the same span file the source-tracking façade writes.
    const merged = Layer.mergeAll(repoLayer, baseLayer, otelLayerOrEmpty());
    this.runtime = ManagedRuntime.make(merged);

    if (!fs.existsSync(this.gitDir)) {
      this.logger.debug('initializing lite shadow git repo');
      await this.gitInit();
    } else {
      // existing repo: just switchTo
      const cfg = Schema.decodeUnknownSync(SwitchCfgSchema)({
        dir: this.projectPath,
        gitdir: this.gitDir,
        roots: this.rootsBranded,
        fdPermits: FD_PERMITS_DEFAULT,
      });
      await this.runEffect(
        Effect.flatMap(Repo, (r) => r.switchTo(cfg)),
        'init.switchTo'
      );
      await this.runEffect(
        Effect.flatMap(Repo, (r) => r.setInfoExclude(buildExclude(this.packageDirs))),
        'init.setInfoExclude'
      );
    }
  }

  public async gitInit(): Promise<void> {
    await fs.promises.mkdir(this.gitDir, { recursive: true });
    const cfg = Schema.decodeUnknownSync(SwitchCfgSchema)({
      dir: this.projectPath,
      gitdir: this.gitDir,
      roots: this.rootsBranded,
      fdPermits: FD_PERMITS_DEFAULT,
    });
    await this.runEffect(
      Effect.flatMap(Repo, (r) => r.init(cfg)),
      'gitInit'
    );
    await this.runEffect(
      Effect.flatMap(Repo, (r) => r.setInfoExclude(buildExclude(this.packageDirs))),
      'gitInit.setInfoExclude'
    );
  }

  public async delete(): Promise<string> {
    await fs.promises.rm(this.gitDir, { recursive: true, force: true });
    ShadowRepoLite.instanceMap.delete(this.projectPath);
    return this.gitDir;
  }

  public getStatus(noCache = false): Promise<StatusRow[]> {
    return this.runEffect(
      Effect.fn('ShadowRepoLite.getStatus')(
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
        function* (this: ShadowRepoLite) {
          const elCapture = eventLoopDelayCapture();
          yield* Effect.annotateCurrentSpan({ noCache, packageDirCount: this.packageDirs.length });
          this.logger.trace(`lite start: getStatus (noCache = ${noCache})`);

          if (!this.status || noCache) {
            const repo = yield* Repo;
            const filter = liteFileFilter(this.packageDirs);
            // Stay in Stream-land: filter, project to StatusRow, normalize
            // for Windows, then materialize ONCE at the boundary into the
            // public StatusRow[] contract.
            const rows = yield* repo.statusMatrix().pipe(
              Stream.filter((e) => filter(e.path)),
              Stream.map(toStatusRow),
              IS_WINDOWS ? Stream.map((row): StatusRow => [path.normalize(row[0]), row[1], row[2], row[3]]) : (s) => s,
              Stream.runCollect
            );
            this.status = Array.from(rows);

            if (env.getBoolean('SF_DISABLE_SOURCE_MOBILITY') === true) {
              yield* Effect.promise(() =>
                Lifecycle.getInstance().emitTelemetry({ eventName: 'moveFileDetectionDisabled' })
              );
            } else {
              yield* Effect.promise(() =>
                Lifecycle.getInstance().emitTelemetry({ eventName: 'moveFileDetectionEnabled' })
              );
              yield* Effect.promise(() => this.detectMovedFiles());
            }
          }

          yield* Effect.annotateCurrentSpan({ rowCount: this.status.length });
          yield* elCapture.finalize();
          return this.status;
        }.bind(this)
      )(),
      'getStatus'
    );
  }

  public async getChangedRows(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter((r) => r[1] !== r[2]);
  }
  public async getChangedFilenames(): Promise<string[]> {
    return toFilenames(await this.getChangedRows());
  }
  public async getDeletes(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter(isDeleted);
  }
  public async getDeleteFilenames(): Promise<string[]> {
    return toFilenames(await this.getDeletes());
  }
  public async getNonDeletes(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter((r) => r[2] === 2);
  }
  public async getNonDeleteFilenames(): Promise<string[]> {
    return toFilenames(await this.getNonDeletes());
  }
  public async getAdds(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter(isAdded);
  }
  public async getAddFilenames(): Promise<string[]> {
    return toFilenames(await this.getAdds());
  }
  public async getModifies(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter((r) => r[1] === 1 && r[2] === 2);
  }
  public async getModifyFilenames(): Promise<string[]> {
    return toFilenames(await this.getModifies());
  }

  public commitChanges(request: CommitRequest = {}): Promise<string | undefined> {
    return this.runEffect(
      Effect.fn('ShadowRepoLite.commitChanges')(
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
        function* (this: ShadowRepoLite) {
          const elCapture = eventLoopDelayCapture();
          const {
            deployedFiles = [],
            deletedFiles = [],
            message = 'sfdx source tracking',
            needsUpdatedStatus = true,
          } = request;
          yield* Effect.annotateCurrentSpan({
            deployedCount: deployedFiles.length,
            deletedCount: deletedFiles.length,
          });
          if (deployedFiles.length === 0 && deletedFiles.length === 0) {
            yield* elCapture.finalize();
            return 'no files to commit';
          }
          const toRepoPath = (p: string): RepoPath =>
            Schema.decodeUnknownSync(RepoPathSchema)(IS_WINDOWS ? ensurePosix(p) : p);
          const adds = Stream.fromIterable([...new Set(deployedFiles)].map(toRepoPath));
          const removes = Stream.fromIterable([...new Set(deletedFiles)].map(toRepoPath));
          const repo = yield* Repo;
          const sha = yield* repo.applyChanges({ adds, removes, message, author: SHADOW_AUTHOR });
          if (needsUpdatedStatus) {
            yield* Effect.promise(() => this.getStatus(true));
          }
          yield* elCapture.finalize();
          return sha;
        }.bind(this)
      )(),
      'commitChanges'
    );
  }

  private detectMovedFiles(): Promise<void> {
    return this.runEffect(
      Effect.fn('ShadowRepoLite.detectMovedFiles')(
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
        function* (this: ShadowRepoLite) {
          const elCapture = eventLoopDelayCapture();
          const matchingFiles = getMatches(this.status);
          yield* Effect.annotateCurrentSpan({
            addedCount: matchingFiles.added.size,
            deletedCount: matchingFiles.deleted.size,
          });
          if (!matchingFiles.added.size || !matchingFiles.deleted.size) {
            yield* elCapture.finalize();
            return;
          }
          // Lite move-detection: drains streamHeadTree once for the
          // recorded oids of deleted files (one tree walk for all of them),
          // and lite's hashBlob for the workdir adds. Returns the file
          // lists + log line ready for commitChanges.
          const result = yield* filenameMatchesToMapLite(this.registry)(this.projectPath)(FD_PERMITS_DEFAULT)(
            matchingFiles
          );
          yield* Effect.annotateCurrentSpan({ moveCount: result.count });
          if (result.count === 0) {
            yield* elCapture.finalize();
            return;
          }
          this.logger.debug(result.logMessage);
          yield* Effect.promise(() =>
            this.commitChanges({
              deployedFiles: [...result.deployedFiles],
              deletedFiles: [...result.deletedFiles],
              message: 'Committing moved files',
            })
          );
          yield* elCapture.finalize();
        }.bind(this)
      )(),
      'detectMovedFiles'
    );
  }

  /**
   * Boundary helper. Inside Effect-land we keep RepoError typed so we can
   * still pattern-match if needed; only the very last step before the
   * Promise rejection converts to SfError, which is what existing
   * source-tracking callers expect to catch.
   */
  private runEffect<A>(eff: Effect.Effect<A, RepoError, Repo | FileSystem | Path>, op: string): Promise<A> {
    return this.runtime.runPromise(
      eff.pipe(
        Effect.tapError((e) => Effect.sync(() => this.logger?.debug(`ShadowRepoLite.${op} failed: ${e.message}`))),
        Effect.mapError(repoErrorToSfError)
      )
    );
  }
}
