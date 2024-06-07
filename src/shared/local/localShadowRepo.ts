/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import path from 'node:path';
import * as os from 'node:os';
import * as fs from 'graceful-fs';
import { NamedPackageDir, Lifecycle, Logger, SfError } from '@salesforce/core';
import { env } from '@salesforce/kit';
// @ts-expect-error isogit has both ESM and CJS exports but node16 module/resolution identifies it as ESM
import git from 'isomorphic-git';
import { Performance } from '@oclif/core/performance';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { chunkArray, excludeLwcLocalOnlyTest, folderContainsPath } from '../functions';
import { filenameMatchesToMap, getMatches } from './moveDetection';
import { StatusRow } from './types';
import { isDeleted, isAdded, toFilenames } from './functions';

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

// array members for status results
export const FILE = 0;
export const HEAD = 1;
export const WORKDIR = 2;
// We don't use STAGE (StatusRow[3]). Changes are added and committed in one step

type CommitRequest = {
  deployedFiles?: string[];
  deletedFiles?: string[];
  message?: string;
  needsUpdatedStatus?: boolean;
};

const IS_WINDOWS = os.type() === 'Windows_NT';

/** do not try to add more than this many files at a time through isogit.  You'll hit EMFILE: too many open files even with graceful-fs */

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

  private constructor(options: ShadowRepoOptions) {
    this.gitDir = getGitDir(options.orgId, options.projectPath);
    this.projectPath = options.projectPath;
    this.packageDirs = options.packageDirs.map(packageDirToRelativePosixPath(options.projectPath));
    this.registry = options.registry;
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
    await fs.promises.mkdir(this.gitDir, { recursive: true });
    try {
      await git.init({ fs, dir: this.projectPath, gitdir: this.gitDir, defaultBranch: 'main' });
    } catch (e) {
      redirectToCliRepoError(e);
    }
  }

  /**
   * Delete the local tracking files
   *
   * @returns the deleted directory
   */
  public async delete(): Promise<string> {
    if (typeof fs.promises.rm === 'function') {
      await fs.promises.rm(this.gitDir, { recursive: true, force: true });
    } else {
      await fs.promises.rm(this.gitDir, { recursive: true });
    }
    return this.gitDir;
  }
  /**
   * If the status already exists, return it.  Otherwise, set the status before returning.
   * It's kinda like a cache
   *
   * @params noCache: if true, force a redo of the status using FS even if it exists
   *
   * @returns StatusRow[]
   */
  public async getStatus(noCache = false): Promise<StatusRow[]> {
    this.logger.trace(`start: getStatus (noCache = ${noCache})`);

    if (!this.status || noCache) {
      const marker = Performance.mark('@salesforce/source-tracking', 'localShadowRepo.getStatus#withoutCache');

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

        // Check for moved files and update local git status accordingly
        if (env.getBoolean('SF_BETA_TRACK_FILE_MOVES') === true) {
          await Lifecycle.getInstance().emitTelemetry({ eventName: 'moveFileDetectionEnabled' });
          await this.detectMovedFiles();
        } else {
          // Adding this telemetry for easier tracking of how many users are using the beta feature
          // This telemetry even will remain when the feature is GA and we switch to opt-out
          await Lifecycle.getInstance().emitTelemetry({ eventName: 'moveFileDetectionDisabled' });
        }
      } catch (e) {
        redirectToCliRepoError(e);
      }
      // isomorphic-git stores things in unix-style tree.  Convert to windows-style if necessary
      if (IS_WINDOWS) {
        this.status = this.status.map((row) => [path.normalize(row[FILE]), row[HEAD], row[WORKDIR], row[3]]);
      }
      marker?.stop();
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

    const marker = Performance.mark('@salesforce/source-tracking', 'localShadowRepo.commitChanges', {
      deployedFiles: deployedFiles.length,
      deletedFiles: deletedFiles.length,
    });

    if (deployedFiles.length) {
      const chunks = chunkArray(
        // these are stored in posix/style/path format.  We have to convert inbound stuff from windows
        [...new Set(IS_WINDOWS ? deployedFiles.map(normalize).map(ensurePosix) : deployedFiles)],
        MAX_FILE_ADD
      );
      for (const chunk of chunks) {
        try {
          this.logger.debug(`adding ${chunk.length} files of ${deployedFiles.length} deployedFiles to git`);
          // these need to be done sequentially (it's already batched) because isogit manages file locking
          // eslint-disable-next-line no-await-in-loop
          await git.add({
            fs,
            dir: this.projectPath,
            gitdir: this.gitDir,
            filepath: chunk,
            force: true,
          });
        } catch (e) {
          if (e instanceof git.Errors.MultipleGitError) {
            this.logger.error(`${e.errors.length} errors on git.add, showing the first 5:`, e.errors.slice(0, 5));
            throw SfError.create({
              message: e.message,
              name: e.name,
              data: e.errors.map((err) => err.message),
              cause: e,
              actions: [
                `One potential reason you're getting this error is that the number of files that source tracking is batching exceeds your user-specific file limits. Increase your hard file limit in the same session by executing 'ulimit -Hn ${MAX_FILE_ADD}'.  Or set the 'SFDX_SOURCE_TRACKING_BATCH_SIZE' environment variable to a value lower than the output of 'ulimit -Hn'.\nNote: Don't set this environment variable too close to the upper limit or your system will still hit it. If you continue to get the error, lower the value of the environment variable even more.`,
              ],
            });
          }
          redirectToCliRepoError(e);
        }
      }
    }

    if (deletedFiles.length) {
      // Using a cache here speeds up the performance by ~24.4%
      let cache = {};
      const deleteMarker = Performance.mark('@salesforce/source-tracking', 'localShadowRepo.commitChanges#delete', {
        deletedFiles: deletedFiles.length,
      });
      for (const filepath of [...new Set(IS_WINDOWS ? deletedFiles.map(normalize).map(ensurePosix) : deletedFiles)]) {
        try {
          // these need to be done sequentially because isogit manages file locking.  Isogit remove does not support multiple files at once
          // eslint-disable-next-line no-await-in-loop
          await git.remove({ fs, dir: this.projectPath, gitdir: this.gitDir, filepath, cache });
        } catch (e) {
          redirectToCliRepoError(e);
        }
      }
      // clear cache
      cache = {};
      deleteMarker?.stop();
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
    marker?.stop();
  }

  private async detectMovedFiles(): Promise<void> {
    const matchingFiles = getMatches(await this.getStatus());
    if (!matchingFiles.added.size || !matchingFiles.deleted.size) return;

    const movedFilesMarker = Performance.mark('@salesforce/source-tracking', 'localShadowRepo.detectMovedFiles');
    const matches = await filenameMatchesToMap(IS_WINDOWS)(this.registry)(this.projectPath)(this.gitDir)(matchingFiles);

    if (matches.size === 0) return movedFilesMarker?.stop();

    this.logger.debug(
      [
        'Files have moved. Committing moved files:',
        [...matches.entries()].map(([add, del]) => `- File ${del} was moved to ${add}`).join(os.EOL),
      ].join(os.EOL)
    );

    movedFilesMarker?.addDetails({ filesMoved: matches.size });

    // Commit the moved files and refresh the status
    await this.commitChanges({
      deletedFiles: [...matches.values()],
      deployedFiles: [...matches.keys()],
      message: 'Committing moved files',
    });

    movedFilesMarker?.stop();
  }
}

const packageDirToRelativePosixPath =
  (projectPath: string) =>
  (packageDir: NamedPackageDir): string =>
    IS_WINDOWS
      ? ensurePosix(path.relative(projectPath, packageDir.fullPath))
      : path.relative(projectPath, packageDir.fullPath);

const normalize = (filepath: string): string => path.normalize(filepath);
const ensurePosix = (filepath: string): string => filepath.split(path.sep).join(path.posix.sep);

const fileFilter =
  (packageDirs: string[]) =>
  (f: string): boolean =>
    // no hidden files
    !f.includes(`${path.sep}.`) &&
    // no lwc tests
    excludeLwcLocalOnlyTest(f) &&
    // no gitignore files
    !f.endsWith('.gitignore') &&
    // isogit uses `startsWith` for filepaths so it's possible to get a false positive
    packageDirs.some(folderContainsPath(f));
