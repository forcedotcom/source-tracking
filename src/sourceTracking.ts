/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

export interface ChangeOptions {
  origin?: 'local' | 'remote';
  state: 'add' | 'delete' | 'changed' | 'unchanged' | 'moved';
}

export interface UpdateOptions {
  files: string[];
}

export class SourceTracking {
  /**
   * Get metadata changes made locally and in the org.
   *
   * @returns local and remote changed metadata
   */
  public async getChanges(options?: ChangeOptions): Promise<string[]> {
    // by default return all local and remote changes
    return [];
  }

  /**
   * Update tracking for the options passed.
   *
   * @param options the files to update
   */
  public async update(options?: UpdateOptions): Promise<void> {
    // update local and remote tracking
    // by default update everything
  }
}
