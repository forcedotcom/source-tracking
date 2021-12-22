/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
/* eslint-disable no-console */

import * as path from 'path';
import * as os from 'os';
import { NamedPackageDir, Logger, fs } from '@salesforce/core';
import * as git from 'isomorphic-git';
import { pathIsInFolder } from './functions';

const gitIgnoreFileName = '.gitignore';
const stashedGitIgnoreFileName = '.BAK.gitignore';
/**
 * returns the full path to where we store the shadow repo
 */
const getGitDir = (orgId: string, projectPath: string): string => {
  return path.join(projectPath, '.sfdx', 'orgs', orgId, 'localSourceTracking');
};

// filenames were normalized when read from isogit
const toFilenames = (rows: StatusRow[]): string[] => rows.map((row) => row[FILE]);

interface ShadowRepoOptions {
  orgId: string;
  projectPath: string;
  packageDirs: NamedPackageDir[];
}

// https://isomorphic-git.org/docs/en/statusMatrix#docsNav
type StatusRow = [file: string, head: number, workdir: number, stage: number];

// array members for status results
const FILE = 0;
const HEAD = 1;
const WORKDIR = 2;

interface CommitRequest {
  deployedFiles?: string[];
  deletedFiles?: string[];
  message?: string;
}

// const gitIgnoreLocator = async (filepath: string) => {
//   ( return filepath.endsWith(gitIgnoreFileName) ? filepath : null).filter(isString);
// }
export class ShadowRepo {
  private static instance: ShadowRepo;

  public gitDir: string;
  public projectPath: string;

  private packageDirs!: NamedPackageDir[];
  private status!: StatusRow[];
  private logger!: Logger;
  private gitIgnoreLocations: string[] = [];

  private constructor(options: ShadowRepoOptions) {
    this.gitDir = getGitDir(options.orgId, options.projectPath);
    this.projectPath = options.projectPath;
    this.packageDirs = options.packageDirs;
  }

  public static async getInstance(options: ShadowRepoOptions): Promise<ShadowRepo> {
    if (!ShadowRepo.instance) {
      ShadowRepo.instance = new ShadowRepo(options);
      await ShadowRepo.instance.init();
    }
    return ShadowRepo.instance;
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
    await fs.promises.mkdir(this.gitDir, { recursive: true });
    await git.init({ fs, dir: this.projectPath, gitdir: this.gitDir, defaultBranch: 'main' });
    // set the forceIgnoreLocations so we only have to do it once
    // this looks through
    this.gitIgnoreLocations = (
      (await git.walk({
        fs,
        dir: this.projectPath,
        gitdir: this.gitDir,
        trees: [git.WORKDIR()],
        // TODO: this can be marginally faster if we limit it to pkgDirs and toplevel project files
        // eslint-disable-next-line @typescript-eslint/require-await
        map: async (filepath: string) => filepath,
      })) as string[]
    )
      .filter(
        (filepath) =>
          filepath.includes(gitIgnoreFileName) &&
          // can be top-level like '.' (no sep) OR must be in one of the package dirs
          (!filepath.includes(path.sep) || this.packageDirs.some((dir) => pathIsInFolder(filepath, dir.path)))
      )
      .map((ignoreFile) => path.join(this.projectPath, ignoreFile));
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
      // when node 12 support is over, switch to promise version
      fs.rmdirSync(this.gitDir, { recursive: true });
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
    if (!this.status || noCache) {
      try {
        // only ask about OS once but use twice
        const isWindows = os.type() === 'Windows_NT';
        await this.stashIgnoreFile();
        const filepaths = isWindows
          ? // iso-git uses posix paths, but packageDirs has already normalized them so we need to convert if windows
            this.packageDirs.map((dir) => dir.path.split(path.sep).join(path.posix.sep))
          : this.packageDirs.map((dir) => dir.path);
        // status hasn't been initalized yet
        this.status = await git.statusMatrix({
          fs,
          dir: this.projectPath,
          gitdir: this.gitDir,
          filepaths,
          // filter out hidden files and __tests__ patterns, regardless of gitignore, and the gitignore files themselves
          filter: (f) =>
            !f.includes(`${path.sep}.`) &&
            !f.includes('__tests__') &&
            ![gitIgnoreFileName, stashedGitIgnoreFileName].includes(path.basename(f)) &&
            // isogit uses `startsWith` for filepaths so it's possible to get a false positive
            filepaths.some((pkgDir) => pathIsInFolder(f, pkgDir, path.posix.sep)),
        });
        // isomorphic-git stores things in unix-style tree.  Convert to windows-style if necessary
        if (isWindows) {
          this.status = this.status.map((row) => [path.normalize(row[FILE]), row[HEAD], row[WORKDIR], row[3]]);
        }
      } finally {
        await this.unStashIgnoreFile();
      }
    }
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
  }: CommitRequest = {}): Promise<string> {
    // if no files are specified, commit all changes
    if (deployedFiles.length === 0 && deletedFiles.length === 0) {
      // this is valid, might not be an error
      return 'no files to commit';
    }

    this.logger.debug('changes are', deployedFiles);
    this.logger.debug('deletes are', deletedFiles);

    await this.stashIgnoreFile();

    // these are stored in posix/style/path format.  We have to convert inbound stuff from windows
    if (os.type() === 'Windows_NT') {
      deployedFiles = deployedFiles.map((filepath) => path.normalize(filepath).split(path.sep).join(path.posix.sep));
      deletedFiles = deletedFiles.map((filepath) => path.normalize(filepath).split(path.sep).join(path.posix.sep));
    }

    try {
      // stage changes
      await Promise.all([
        ...deployedFiles.map((filepath) => git.add({ fs, dir: this.projectPath, gitdir: this.gitDir, filepath })),
        ...deletedFiles.map((filepath) => git.remove({ fs, dir: this.projectPath, gitdir: this.gitDir, filepath })),
      ]);

      const sha = await git.commit({
        fs,
        dir: this.projectPath,
        gitdir: this.gitDir,
        message,
        author: { name: 'sfdx source tracking' },
      });
      // status changed as a result of the commit.  This prevents users from having to run getStatus(true) to avoid cache
      await this.getStatus(true);
      return sha;
    } finally {
      await this.unStashIgnoreFile();
    }
  }

  private async stashIgnoreFile(): Promise<void> {
    // allSettled allows them to fail (example, the file wasn't where it was expected).
    await Promise.allSettled(
      this.gitIgnoreLocations.map((originalLocation) =>
        fs.promises.rename(originalLocation, originalLocation.replace(gitIgnoreFileName, stashedGitIgnoreFileName))
      )
    );
  }

  private async unStashIgnoreFile(): Promise<void> {
    // allSettled allows them to fail (example, the file wasn't where it was expected).
    await Promise.allSettled(
      this.gitIgnoreLocations.map((originalLocation) =>
        fs.promises.rename(originalLocation.replace(gitIgnoreFileName, stashedGitIgnoreFileName), originalLocation)
      )
    );
  }
}
