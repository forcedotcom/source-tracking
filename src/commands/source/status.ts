/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { SfdxProject, Org } from '@salesforce/core';

import { ChangeResult, SourceTracking } from '../../sourceTracking';

// array members for status results
// https://isomorphic-git.org/docs/en/statusMatrix#docsNav
// const FILE = 0;
// const HEAD = 1;
// const WORKDIR = 2;

interface TemporaryOutput {
  local?: {
    adds: ChangeResult[];
    deletes: ChangeResult[];
    modifies: ChangeResult[];
  };
  remote?: {
    deletes: ChangeResult[];
    modifies: ChangeResult[];
  };
  conflicts?: ChangeResult[];
}

export default class SourceStatus extends SfdxCommand {
  public static description = 'get local changes';
  protected static flagsConfig: FlagsConfig = {
    all: flags.boolean({ char: 'a', description: 'tbd' }),
    local: flags.boolean({ char: 'l', description: 'tbd' }),
    remote: flags.boolean({ char: 'r', description: 'tbd' }),
  };
  protected static requiresUsername = true;
  protected static requiresProject = true;
  protected project!: SfdxProject;
  protected org!: Org;

  public async run(): Promise<TemporaryOutput> {
    this.logger.debug(
      `project is ${this.project.getPath()} and pkgDirs are ${this.project
        .getPackageDirectories()
        .map((dir) => dir.path)
        .join(',')}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output: TemporaryOutput = {};
    const tracking = new SourceTracking({
      org: this.org,
      project: this.project,
    });

    if (this.flags.local || this.flags.all || (!this.flags.remote && !this.flags.all)) {
      await tracking.ensureLocalTracking();
      const [deletes, modifies, adds] = await Promise.all([
        tracking.getChanges({ origin: 'local', state: 'delete' }),
        tracking.getChanges({ origin: 'local', state: 'changed' }),
        tracking.getChanges({ origin: 'local', state: 'add' }),
      ]);
      output.local = {
        deletes,
        modifies,
        adds,
      };
    }

    if (this.flags.remote || this.flags.all || (!this.flags.local && !this.flags.all)) {
      await tracking.ensureRemoteTracking();

      const deletes = await tracking.getChanges({ origin: 'remote', state: 'delete' });
      const modifies = await tracking.getChanges({ origin: 'remote', state: 'changed' });
      output.remote = {
        deletes: tracking.populateFilePaths(deletes),
        modifies: tracking.populateFilePaths(modifies),
      };
    }

    output.conflicts = await tracking.getConflicts();
    if (!this.flags.json) {
      this.ux.logJson(output);
    }

    return output;
  }
}
