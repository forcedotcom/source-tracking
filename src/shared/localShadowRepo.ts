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
import git, { Walker } from 'isomorphic-git';
import { Performance } from '@oclif/core';
import { chunkArray, excludeLwcLocalOnlyTest, folderContainsPath } from './functions';

/** returns the full path to where we store the shadow repo */
const getGitDir = (orgId: string, projectPath: string): string =>
  path.join(projectPath, '.sf', 'orgs', orgId, 'localSourceTracking');

// filenames were normalized when read from isogit
const toFilenames = (rows: StatusRow[]): string[] => rows.map((row) => row[FILE]);

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
};

// https://isomorphic-git.org/docs/en/statusMatrix#docsNav
type StatusRow = [file: string, head: number, workdir: number, stage: number];

// array members for status results
const FILE = 0;
const HEAD = 1;
const WORKDIR = 2;
// We don't use STAGE (StatusRow[3]). Changes are added and committed in one step

type CommitRequest = {
  deployedFiles?: string[];
  deletedFiles?: string[];
  message?: string;
  needsUpdatedStatus?: boolean;
};

export class ShadowRepo {
  private static instanceMap = new Map<string, ShadowRepo>();

  public gitDir: string;
  public projectPath: string;

  private packageDirs!: NamedPackageDir[];
  private status!: StatusRow[];
  private logger!: Logger;
  private readonly isWindows: boolean;

  /** do not try to add more than this many files at a time through isogit.  You'll hit EMFILE: too many open files even with graceful-fs */
  private readonly maxFileAdd: number;

  private constructor(options: ShadowRepoOptions) {
    this.gitDir = getGitDir(options.orgId, options.projectPath);
    this.projectPath = options.projectPath;
    this.packageDirs = options.packageDirs;
    this.isWindows = os.type() === 'Windows_NT';

    this.maxFileAdd = env.getNumber(
      'SF_SOURCE_TRACKING_BATCH_SIZE',
      env.getNumber('SFDX_SOURCE_TRACKING_BATCH_SIZE', this.isWindows ? 8000 : 15_000)
    );
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
      // iso-git uses relative, posix paths
      // but packageDirs has already resolved / normalized them
      // so we need to make them project-relative again and convert if windows
      const pkgDirs = this.packageDirs.map(packageDirToRelativePosixPath(this.isWindows)(this.projectPath));

      try {
        // status hasn't been initialized yet
        this.status = await git.statusMatrix({
          fs,
          dir: this.projectPath,
          gitdir: this.gitDir,
          filepaths: pkgDirs,
          ignored: true,
          filter: (f) =>
            // no hidden files
            !f.includes(`${path.sep}.`) &&
            // no lwc tests
            excludeLwcLocalOnlyTest(f) &&
            // no gitignore files
            !f.endsWith('.gitignore') &&
            // isogit uses `startsWith` for filepaths so it's possible to get a false positive
            pkgDirs.some(folderContainsPath(f)),
        });

        // Check for moved files and update local git status accordingly
        await this.detectMovedFiles();
      } catch (e) {
        redirectToCliRepoError(e);
      }
      // isomorphic-git stores things in unix-style tree.  Convert to windows-style if necessary
      if (this.isWindows) {
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
    return (await this.getStatus()).filter((file) => file[WORKDIR] === 0);
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
    return (await this.getStatus()).filter((file) => file[HEAD] === 0 && file[WORKDIR] === 2);
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
        [...new Set(this.isWindows ? deployedFiles.map(normalize).map(ensurePosix) : deployedFiles)],
        this.maxFileAdd
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
                `One potential reason you're getting this error is that the number of files that source tracking is batching exceeds your user-specific file limits. Increase your hard file limit in the same session by executing 'ulimit -Hn ${this.maxFileAdd}'.  Or set the 'SFDX_SOURCE_TRACKING_BATCH_SIZE' environment variable to a value lower than the output of 'ulimit -Hn'.\nNote: Don't set this environment variable too close to the upper limit or your system will still hit it. If you continue to get the error, lower the value of the environment variable even more.`,
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
      for (const filepath of [
        ...new Set(this.isWindows ? deletedFiles.map(normalize).map(ensurePosix) : deletedFiles),
      ]) {
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
    // Check for moved files in incremental steps to avoid performance degradation
    // Deleted files will be more rare than added files, so we'll check them first and exit early if there are none
    const deletedFiles = this.status.filter((file) => file[WORKDIR] === 0);
    if (!deletedFiles.length) return;

    const addedFiles = this.status.filter((file) => file[HEAD] === 0 && file[WORKDIR] === 2);
    if (!addedFiles.length) return;

    // Both arrays have contents, look for matching basenames
    // TODO: get basenames onces and use them for both arrays
    const addedFilenames = toFilenames(addedFiles);
    const deletedFilenames = toFilenames(deletedFiles);

    const deletedFilenamesWithMatches = deletedFilenames.filter((delFile) =>
      addedFilenames.some((addFile) => path.basename(addFile) === path.basename(delFile))
    );
    if (!deletedFilenamesWithMatches.length) return;

    const addedFilenamesWithMatches = addedFilenames.filter((addFile) =>
      deletedFilenames.some((delFile) => path.basename(addFile) === path.basename(delFile))
    );
    if (!addedFilenamesWithMatches.length) return;

    const movedFilesMarker = Performance.mark('@salesforce/source-tracking', 'localShadowRepo.detectMovedFiles');
    // We found file adds and deletes with the same basename
    // The have likely been moved, confirm by comparing their hashes (oids)
    const getInfo = async (
      targetTree: Walker,
      filenameArray: string[]
    ): Promise<Array<{ filename: string; hash: string; basename: string }>> =>
      // Unable to properly type the return value of git.walk without using "as", so we'll just ignore the type check
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      git.walk({
        fs,
        dir: this.projectPath,
        gitdir: this.gitDir,
        trees: [targetTree],
        map: async (filepath, [tree]) =>
          filenameArray.includes(filepath) && (await tree?.type()) === 'blob'
            ? {
                filename: filepath,
                hash: await tree?.oid(),
                basename: path.basename(filepath),
              }
            : undefined,
      });

    // Track how long it takes to gather the oid information from the git trees
    const getInfoMarker = Performance.mark('@salesforce/source-tracking', 'localShadowRepo.detectMovedFiles#getInfo', {
      addedFiles: addedFilenamesWithMatches.length,
      deletedFiles: deletedFilenamesWithMatches.length,
    });
    const addedInfo = await getInfo(git.WORKDIR(), addedFilenamesWithMatches);
    const deletedInfo = await getInfo(git.TREE({ ref: 'HEAD' }), deletedFilenamesWithMatches);
    getInfoMarker?.stop();

    // Iterate over the added files and find the matching deleted files (we want to compare the hash AND the basename)
    // Push moved file details to the moveLogs array for later logging
    const moveLogs: string[] = [];
    const addedFilesWithMatches = addedInfo
      .filter((addedFile) =>
        deletedInfo.find(
          (deletedFile) =>
            addedFile.basename === deletedFile.basename &&
            addedFile.hash === deletedFile.hash &&
            !!moveLogs.push(`File '${deletedFile.filename}' was moved to '${addedFile.filename}'`)
        )
      )
      .map((addedFile) => addedFile.filename);

    // Iterate over the deleted files also to look for matching added files
    // We need to confirm that they do not match more than one added file
    // If they do, we cannot determine which file was moved and will abort the commit
    const deletedFilesWithMatches = deletedInfo
      .filter((deletedFile) =>
        addedInfo.find(
          (addedFile) => addedFile.basename === deletedFile.basename && addedFile.hash === deletedFile.hash
        )
      )
      .map((deletedFile) => deletedFile.filename);

    // Ensure file moves have been detected
    if (addedFilesWithMatches.length && deletedFilesWithMatches.length) {
      // If the length of these arrays are different, then we ran into a situation where multiple files have the same hash and basename
      if (addedFilesWithMatches.length !== deletedFilesWithMatches.length) {
        const message =
          'File move detection failed. Multiple files have the same hash and basename. Skipping commit of moved files';
        this.logger.warn(message);
        await Lifecycle.getInstance().emitWarning(message);
      } else {
        this.logger.debug('Files have moved. Committing moved files:');
        this.logger.debug(moveLogs.join('\n'));
        movedFilesMarker?.addDetails({ filesMoved: moveLogs.length });

        // Commit the moved files and refresh the status
        await this.commitChanges({
          deletedFiles: deletedFilesWithMatches,
          deployedFiles: addedFilesWithMatches,
          message: 'Committing moved files',
        });
      }
    }

    movedFilesMarker?.stop();
  }
}

const packageDirToRelativePosixPath =
  (isWindows: boolean) =>
  (projectPath: string) =>
  (packageDir: NamedPackageDir): string =>
    isWindows
      ? ensurePosix(path.relative(projectPath, packageDir.fullPath))
      : path.relative(projectPath, packageDir.fullPath);

const normalize = (filepath: string): string => path.normalize(filepath);
const ensurePosix = (filepath: string): string => filepath.split(path.sep).join(path.posix.sep);
