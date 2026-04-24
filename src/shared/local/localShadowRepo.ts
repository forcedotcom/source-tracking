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
import * as os from 'node:os';
import * as fs from 'graceful-fs';
import { NamedPackageDir, Lifecycle, Logger, SfError, lockInit } from '@salesforce/core';
import { env } from '@salesforce/kit';
import git from 'isomorphic-git';
import { GitIndexManager } from 'isomorphic-git/managers';
import { FileSystem as IsoGitFS } from 'isomorphic-git/models';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { chunkArray, excludeLwcLocalOnlyTest, folderContainsPath } from '../functions';
import { filenameMatchesToMap, getLogMessage, getMatches } from './moveDetection';
import { StatusRow } from './types';
import { isDeleted, isAdded, toFilenames, IS_WINDOWS, FILE, HEAD, WORKDIR, ensurePosix } from './functions';

/** returns the full path to where we store the shadow repo */
const getGitDir = (orgId: string, projectPath: string): string =>
  path.join(projectPath, '.sf', 'orgs', orgId, 'localSourceTracking');

// catch isogit's `InternalError` to avoid people report CLI issues in isogit repo.
// See: https://github.com/forcedotcom/cli/issues/2416
const redirectToCliRepoError = (e: unknown): never => {
  if (e instanceof git.Errors.InternalError) {
    const error = new SfError(
      `An internal error caused this command to fail. isomorphic-git error:${os.EOL}${e.data.message}`,
      e.name
    );
    throw error;
  }
  throw e;
};

type ShadowRepoOptions = {
  orgId: string;
  projectPath: string;
  packageDirs: NamedPackageDir[];
  registry: RegistryAccess;
};

type CommitRequest = {
  deployedFiles?: string[];
  deletedFiles?: string[];
  message?: string;
  needsUpdatedStatus?: boolean;
};

/** do not try to add more than this many files at a time through isogit.  You'll hit EMFILE: too many open files */
const MAX_FILE_ADD = env.getNumber(
  'SF_SOURCE_TRACKING_BATCH_SIZE',
  env.getNumber('SFDX_SOURCE_TRACKING_BATCH_SIZE', IS_WINDOWS ? 8000 : 15_000)
);

export class ShadowRepo {
  private static instanceMap = new Map<string, ShadowRepo>();

  public gitDir: string;
  public projectPath: string;

  /**
   * packageDirs converted to project-relative posix style paths
   * iso-git uses relative, posix paths
   * but packageDirs has already resolved / normalized them
   * so we need to make them project-relative again and convert if windows
   */
  private packageDirs: string[];
  private status!: StatusRow[];
  private logger!: Logger;
  private readonly registry: RegistryAccess;
  private lockHeld = false;
  private readonly indexLockPath: string;

  private constructor(options: ShadowRepoOptions) {
    this.gitDir = getGitDir(options.orgId, options.projectPath);
    this.projectPath = options.projectPath;
    this.packageDirs = options.packageDirs.map(packageDirToRelativePosixPath(options.projectPath));
    this.registry = options.registry;
    this.indexLockPath = path.join(this.gitDir, 'index');
  }

  // think of singleton behavior but unique to the projectPath
  public static async getInstance(options: ShadowRepoOptions): Promise<ShadowRepo> {
    if (!ShadowRepo.instanceMap.has(options.projectPath)) {
      const newInstance = new ShadowRepo(options);
      await newInstance.init();
      ShadowRepo.instanceMap.set(options.projectPath, newInstance);
    }
    return ShadowRepo.instanceMap.get(options.projectPath) as ShadowRepo;
  }

  public async init(): Promise<void> {
    this.logger = await Logger.child('ShadowRepo');

    // initialize the shadow repo if it doesn't exist
    if (!fs.existsSync(this.gitDir)) {
      this.logger.debug('initializing git repo');
      await this.gitInit();
    }
  }

  /**
   * Initialize a new source tracking shadow repo.  Think of git init
   *
   */
  public async gitInit(): Promise<void> {
    this.logger.trace(`initializing git repo at ${this.gitDir}`);
    await this.withGitLock(async () => {
      await fs.promises.mkdir(this.gitDir, { recursive: true });
      try {
        await git.init({ fs, dir: this.projectPath, gitdir: this.gitDir, defaultBranch: 'main' });
      } catch (e) {
        redirectToCliRepoError(e);
      }
    });
  }

  /**
   * Delete the local tracking files
   *
   * @returns the deleted directory
   */
  public async delete(): Promise<string> {
    return this.withGitLock(async () => {
      await fs.promises.rm(this.gitDir, { recursive: true, force: true });
      return this.gitDir;
    });
  }
  /**
   * If the status already exists, return it.  Otherwise, set the status before returning.
   * It's kinda like a cache
   *
   * @params noCache: if true, force a redo of the status using FS even if it exists
   *
   * @returns StatusRow[] (paths are os-specific)
   */
  public async getStatus(noCache = false): Promise<StatusRow[]> {
    this.logger.trace(`start: getStatus (noCache = ${noCache})`);

    if (!this.status || noCache) {
      // lock reads too: a concurrent write could leave a partially-written index that statusMatrix would misparse
      await this.withGitLock(async () => {
        try {
          // status hasn't been initialized yet
          this.status = await git.statusMatrix({
            fs,
            dir: this.projectPath,
            gitdir: this.gitDir,
            filepaths: this.packageDirs,
            ignored: true,
            filter: fileFilter(this.packageDirs),
          });

          // isomorphic-git stores things in unix-style tree.  Convert to windows-style if necessary
          if (IS_WINDOWS) {
            this.status = this.status.map((row) => [path.normalize(row[FILE]), row[HEAD], row[WORKDIR], row[3]]);
          }

          if (env.getBoolean('SF_DISABLE_SOURCE_MOBILITY') === true) {
            await Lifecycle.getInstance().emitTelemetry({ eventName: 'moveFileDetectionDisabled' });
          } else {
            // Check for moved files and update local git status accordingly
            await Lifecycle.getInstance().emitTelemetry({ eventName: 'moveFileDetectionEnabled' });
            await this.detectMovedFiles();
          }
        } catch (e) {
          redirectToCliRepoError(e);
        }
      });
    }
    this.logger.trace(`done: getStatus (noCache = ${noCache})`);
    return this.status;
  }

  /**
   * returns any change (add, modify, delete)
   */
  public async getChangedRows(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter((file) => file[HEAD] !== file[WORKDIR]);
  }

  /**
   * returns any change (add, modify, delete)
   */
  public async getChangedFilenames(): Promise<string[]> {
    return toFilenames(await this.getChangedRows());
  }

  public async getDeletes(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter(isDeleted);
  }

  public async getDeleteFilenames(): Promise<string[]> {
    return toFilenames(await this.getDeletes());
  }

  /**
   * returns adds and modifies but not deletes
   */
  public async getNonDeletes(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter((file) => file[WORKDIR] === 2);
  }

  /**
   * returns adds and modifies but not deletes
   */
  public async getNonDeleteFilenames(): Promise<string[]> {
    return toFilenames(await this.getNonDeletes());
  }

  public async getAdds(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter(isAdded);
  }

  public async getAddFilenames(): Promise<string[]> {
    return toFilenames(await this.getAdds());
  }

  /**
   * returns files that were not added or deleted, but changed locally
   */
  public async getModifies(): Promise<StatusRow[]> {
    return (await this.getStatus()).filter((file) => file[HEAD] === 1 && file[WORKDIR] === 2);
  }

  public async getModifyFilenames(): Promise<string[]> {
    return toFilenames(await this.getModifies());
  }

  /**
   * Look through status and stage all changes, then commit
   *
   * @param fileList list of files to commit (full paths)
   * @param message: commit message (include org username and id)
   *
   * @returns sha (string)
   */
  public async commitChanges({
    deployedFiles = [],
    deletedFiles = [],
    message = 'sfdx source tracking',
    needsUpdatedStatus = true,
  }: CommitRequest = {}): Promise<string | undefined> {
    // if no files are specified, commit all changes
    if (deployedFiles.length === 0 && deletedFiles.length === 0) {
      // this is valid, might not be an error
      return 'no files to commit';
    }

    return this.withGitLock(async () => {
      // Phase 1: Write blob objects and collect file metadata.
      // Blob writes go to .git/objects/ and are independent of the index.
      // Chunked to avoid EMFILE (too many open files).
      const insertions: Array<{ filepath: string; stats: fs.Stats; oid: string }> = [];

      if (deployedFiles.length) {
        // these are stored in posix/style/path format.  We have to convert inbound stuff from windows
        const uniqueFiles = [...new Set(IS_WINDOWS ? deployedFiles.map(normalize).map(ensurePosix) : deployedFiles)];
        const chunks = chunkArray(uniqueFiles, MAX_FILE_ADD);

        for (const chunk of chunks) {
          this.logger.debug(`writing ${chunk.length} blobs of ${uniqueFiles.length} deployedFiles`);
          // eslint-disable-next-line no-await-in-loop
          const settled = await Promise.allSettled(
            chunk.map(async (filepath) => {
              const fullPath = path.join(this.projectPath, filepath);
              const stats = await fs.promises.lstat(fullPath);
              const fileBuffer = await fs.promises.readFile(fullPath);
              const oid = await git.writeBlob({
                fs,
                dir: this.projectPath,
                gitdir: this.gitDir,
                blob: fileBuffer,
              });
              return { filepath, stats, oid };
            })
          );

          // Mirror isomorphic-git's addToIndex: allSettled -> aggregate errors
          const rejected = settled
            .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
            .map((r) => r.reason as Error);
          if (rejected.length > 1) {
            this.logger.error(`${rejected.length} errors writing blobs, showing the first 5:`, rejected.slice(0, 5));
            throw SfError.create({
              message: `Multiple errors occurred writing blob objects (${rejected.length} failures)`,
              name: 'MultipleGitError',
              data: rejected.map((err) => err.message),
              cause: rejected[0],
              actions: [
                `One potential reason you're getting this error is that the number of files that source tracking is batching exceeds your user-specific file limits. Increase your hard file limit in the same session by executing 'ulimit -Hn ${MAX_FILE_ADD}'.  Or set the 'SFDX_SOURCE_TRACKING_BATCH_SIZE' environment variable to a value lower than the output of 'ulimit -Hn'.\nNote: Don't set this environment variable too close to the upper limit or your system will still hit it. If you continue to get the error, lower the value of the environment variable even more.`,
              ],
            });
          }
          if (rejected.length === 1) {
            redirectToCliRepoError(rejected[0]);
          }

          insertions.push(
            ...settled
              .filter(
                (r): r is PromiseFulfilledResult<{ filepath: string; stats: fs.Stats; oid: string }> =>
                  r.status === 'fulfilled'
              )
              .map((r) => r.value)
          );
        }
      }

      const deletions = deletedFiles.length
        ? [...new Set(IS_WINDOWS ? deletedFiles.map(normalize).map(ensurePosix) : deletedFiles)]
        : [];

      // Phase 2: Single index update — one GitIndexManager.acquire() call reads the index,
      // applies all inserts and deletes in memory, and writes it back once when the callback resolves.
      if (insertions.length || deletions.length) {
        const isoGitFS = new IsoGitFS(fs);
        await GitIndexManager.acquire({ fs: isoGitFS, gitdir: this.gitDir, cache: {} }, (index) => {
          for (const { filepath, stats, oid } of insertions) {
            index.insert({ filepath, stats, oid });
          }
          for (const filepath of deletions) {
            index.delete({ filepath });
          }
        });
      }

      try {
        this.logger.trace('start: commitChanges git.commit');

        const sha = await git.commit({
          fs,
          dir: this.projectPath,
          gitdir: this.gitDir,
          message,
          author: { name: 'sfdx source tracking' },
        });
        // status changed as a result of the commit.  This prevents users from having to run getStatus(true) to avoid cache
        if (needsUpdatedStatus) {
          await this.getStatus(true);
        }
        this.logger.trace('done: commitChanges git.commit');
        return sha;
      } catch (e) {
        redirectToCliRepoError(e);
      }
    });
  }

  /**
   * Cross-process file lock on the git index using proper-lockfile (via @salesforce/core lockInit).
   * The lockHeld flag provides reentrancy within the same process, needed because
   * getStatus() -> detectMovedFiles() -> commitChanges() -> getStatus(true).
   * Cross-process coordination is handled by proper-lockfile's mkdir-based lock.
   */
  private async withGitLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lockHeld) {
      return operation();
    }

    this.logger.trace('acquiring git index lock');
    const { unlock } = await lockInit(this.indexLockPath);
    this.lockHeld = true;
    try {
      return await operation();
    } finally {
      this.lockHeld = false;
      try {
        await unlock();
        this.logger.trace('released git index lock');
      } catch (e) {
        // unlock can fail if gitDir was deleted (e.g., by delete()), which is expected
        this.logger.trace('could not release git index lock (lock dir may have been removed)', e);
      }
    }
  }

  private async detectMovedFiles(): Promise<void> {
    // get status will return os-specific paths
    const matchingFiles = getMatches(await this.getStatus());
    if (!matchingFiles.added.size || !matchingFiles.deleted.size) return;

    const matches = await filenameMatchesToMap(this.registry)(this.projectPath)(this.gitDir)(matchingFiles);

    if (matches.deleteOnly.size === 0 && matches.fullMatches.size === 0) return;

    this.logger.debug(getLogMessage(matches));

    // Commit the moved files and refresh the status
    await this.commitChanges({
      deletedFiles: [...matches.fullMatches.values(), ...matches.deleteOnly.values()],
      deployedFiles: [...matches.fullMatches.keys()],
      message: 'Committing moved files',
    });
  }
}

const packageDirToRelativePosixPath =
  (projectPath: string) =>
  (packageDir: NamedPackageDir): string =>
    IS_WINDOWS
      ? ensurePosix(path.relative(projectPath, packageDir.fullPath))
      : path.relative(projectPath, packageDir.fullPath);

const normalize = (filepath: string): string => path.normalize(filepath);

const fileFilter =
  (packageDirs: string[]) =>
  (f: string): boolean =>
    // no hidden files
    !f.includes(`${path.sep}.`) &&
    // no node_modules (e.g. uiBundle packages inside force-app)
    !f.split(path.sep).includes('node_modules') &&
    // no lwc tests
    excludeLwcLocalOnlyTest(f) &&
    // no gitignore files
    !f.endsWith('.gitignore') &&
    // isogit uses `startsWith` for filepaths so it's possible to get a false positive
    packageDirs.some(folderContainsPath(f));
