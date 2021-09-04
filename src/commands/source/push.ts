/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { Duration } from '@salesforce/kit';
import { SfdxProject, Org } from '@salesforce/core';
import { PushPullResponse } from '../../shared/types';
import { SourceTracking } from '../../sourceTracking';
import { writeConflictTable } from '../../writeConflictTable';
export default class SourcePush extends SfdxCommand {
  public static description = 'get local changes';
  protected static readonly flagsConfig: FlagsConfig = {
    forceoverwrite: flags.boolean({ char: 'f', description: 'overwrite files without prompting' }),
    // TODO: use shared flags from plugin-source
    wait: flags.minutes({
      char: 'w',
      default: Duration.minutes(33),
      min: Duration.minutes(0), // wait=0 means deploy is asynchronous
      description: 'tbd',
    }),
  };

  protected static requiresUsername = true;
  protected static requiresProject = true;

  protected project!: SfdxProject; // ok because requiresProject
  protected org!: Org; // ok because requiresUsername

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async run(): Promise<PushPullResponse[]> {
    const tracking = new SourceTracking({
      org: this.org,
      project: this.project,
    });
    if (!this.flags.forceoverwrite) {
      const conflicts = await tracking.getConflicts();
      if (conflicts.length > 0) {
        writeConflictTable(conflicts, this.ux);
        throw new Error('conflicts detected');
      }
    }
    const deployResult = await tracking.deployLocalChanges({
      ignoreWarnings: this.flags.ignorewarnings as boolean,
      wait: this.flags.wait as Duration,
    });

    // TODO: convert deployResult to the proper type
    // TODO: catch the noChanges to deploy error
    if (!this.flags.json) {
      this.ux.logJson(deployResult);
    }

    return deployResult.map((fileResponse) => ({
      state: fileResponse.state,
      fullName: fileResponse.fullName,
      type: fileResponse.type,
      filePath: fileResponse.filePath,
    }));
  }
}
