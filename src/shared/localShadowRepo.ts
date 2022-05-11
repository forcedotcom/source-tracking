/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'graceful-fs';
import { NamedPackageDir, Logger, SfError } from '@salesforce/core';
import * as git from 'isomorphic-git';
import { chunkArray, pathIsInFolder } from './functions';

/** returns the full path to where we store the shadow repo */
const getGitDir = (orgId: string, projectPath: string, useSfdxTrackingFiles = false): string => {
  return path.join(projectPath, useSfdxTrackingFiles ? '.sfdx' : '.sf', 'orgs', orgId, 'localSourceTracking');
};

// filenames were normalized when read from isogit
const toFilenames = (rows: StatusRow[]): string[] => rows.map((row) => row[FILE]);

interface ShadowRepoOptions {
  orgId: string;
  projectPath: string;
  packageDirs: NamedPackageDir[];
  hasSfdxTrackingFiles: boolean;
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
  needsUpdatedStatus?: boolean;
}

export class ShadowRepo {
  private static instanceMap = new Map<string, ShadowRepo>();

  public gitDir: string;
  public projectPath: string;

  private packageDirs!: NamedPackageDir[];
  private status!: StatusRow[];
  private logger!: Logger;
  private isWindows: boolean;

  /** do not try to add more than this many files at a time through isogit.  You'll hit EMFILE: too many open files even with graceful-fs */
  private maxFileAdd: number;

  private constructor(options: ShadowRepoOptions) {
    this.gitDir = getGitDir(options.orgId, options.projectPath, options.hasSfdxTrackingFiles);
    this.projectPath = options.projectPath;
    this.packageDirs = options.packageDirs;
    this.isWindows = os.type() === 'Windows_NT';
    this.maxFileAdd = this.isWindows ? 8000 : 15000;
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
    await fs.promises.mkdir(this.gitDir, { recursive: true });
    await git.init({ fs, dir: this.projectPath, gitdir: this.gitDir, defaultBranch: 'main' });
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
    if (!this.status || noCache) {
      // iso-git uses relative, posix paths
      // but packageDirs has already resolved / normalized them
      // so we need to make them project-relative again and convert if windows
      const filepaths = this.packageDirs
        .map((dir) => path.relative(this.projectPath, dir.fullPath))
        .map((p) => (this.isWindows ? p.split(path.sep).join(path.posix.sep) : p));

      // status hasn't been initalized yet
      this.status = await git.statusMatrix({
        fs,
        dir: this.projectPath,
        gitdir: this.gitDir,
        filepaths,
        ignored: true,
        filter: (f) =>
          // no hidden files
          !f.includes(`${path.sep}.`) &&
          // no lwc tests
          !f.includes('__tests__') &&
          // no gitignore files
          !f.endsWith('.gitignore') &&
          // isogit uses `startsWith` for filepaths so it's possible to get a false positive
          filepaths.some((pkgDir) => pathIsInFolder(f, pkgDir)),
      });
      // isomorphic-git stores things in unix-style tree.  Convert to windows-style if necessary
      if (this.isWindows) {
        this.status = this.status.map((row) => [path.normalize(row[FILE]), row[HEAD], row[WORKDIR], row[3]]);
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
    needsUpdatedStatus = true,
  }: CommitRequest = {}): Promise<string> {
    // if no files are specified, commit all changes
    if (deployedFiles.length === 0 && deletedFiles.length === 0) {
      // this is valid, might not be an error
      return 'no files to commit';
    }

    // these are stored in posix/style/path format.  We have to convert inbound stuff from windows
    if (os.type() === 'Windows_NT') {
      deployedFiles = deployedFiles.map((filepath) => path.normalize(filepath).split(path.sep).join(path.posix.sep));
      deletedFiles = deletedFiles.map((filepath) => path.normalize(filepath).split(path.sep).join(path.posix.sep));
    }

    if (deployedFiles.length) {
      const chunks = chunkArray([...new Set(deployedFiles)], this.maxFileAdd);
      for (const chunk of chunks) {
        try {
          await git.add({
            fs,
            dir: this.projectPath,
            gitdir: this.gitDir,
            filepath: chunk,
            force: true,
          });
        } catch (e) {
          if (e instanceof git.Errors.MultipleGitError) {
            this.logger.error('multiple errors on git.add', e.errors.slice(0, 5));
            const error = new SfError(e.message, e.name, [], 1);
            error.setData(e.errors);
            throw error;
          }
          throw e;
        }
      }
    }

    for (const filepath of [...new Set(deletedFiles)]) {
      await git.remove({ fs, dir: this.projectPath, gitdir: this.gitDir, filepath });
    }

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
    return sha;
  }
}
