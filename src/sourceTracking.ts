/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { NamedPackageDir } from '@salesforce/core';
import { ShadowRepo } from './shared/localShadowRepo';

export interface ChangeOptions {
  origin?: 'local' | 'remote';
  state: 'add' | 'delete' | 'changed' | 'unchanged' | 'moved';
}

export interface UpdateOptions {
  files: string[];
}

export class SourceTracking {
  private orgId: string;
  private projectPath: string;
  private packagesDirs: NamedPackageDir[];
  private localRepo!: ShadowRepo;

  public constructor({
    orgId,
    projectPath,
    packageDirs,
  }: {
    orgId: string;
    projectPath: string;
    packageDirs: NamedPackageDir[];
  }) {
    this.orgId = orgId;
    this.projectPath = projectPath;
    this.packagesDirs = packageDirs;
  }

  /**
   * Get metadata changes made locally and in the org.
   *
   * @returns local and remote changed metadata
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public async getChanges(options?: ChangeOptions): Promise<string[]> {
    if (options?.origin === 'local') {
      await this.ensureLocalTracking();
      if (options.state === 'changed') {
        return this.localRepo.getNonDeleteFilenames();
      }
      if (options.state === 'delete') {
        return this.localRepo.getDeleteFilenames();
      }
    }

    // by default return all local and remote changes
    // eslint-disable-next-line no-console
    console.log(options);
    return [];
  }

  /**
   * Update tracking for the options passed.
   *
   * @param options the files to update
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  public async update(options?: UpdateOptions): Promise<void> {
    // update local and remote tracking
    // by default update everything
    // eslint-disable-next-line no-console
    // console.log(options);
    await this.ensureLocalTracking();
    await this.localRepo.commitChanges({ deployedFiles: options?.files });
  }

  /**
   * If the local tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists.
   * Useful before parallel operations
   */
  public async ensureLocalTracking(): Promise<void> {
    if (this.localRepo) {
      return;
    }
    this.localRepo = await ShadowRepo.create({
      orgId: this.orgId,
      projectPath: this.projectPath,
      packageDirs: this.packagesDirs,
    });
  }
}
