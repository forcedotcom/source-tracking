/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { Duration } from '@salesforce/kit';
import { SfdxProject, Org } from '@salesforce/core';
import { writeConflictTable } from '../../writeConflictTable';
import { SourceTracking } from '../../sourceTracking';
export default class SourcePull extends SfdxCommand {
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
  protected project!: SfdxProject;
  protected org!: Org;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async run(): Promise<any> {
    const tracking = await SourceTracking.create({
      org: this.org,
      project: this.project,
      apiVersion: this.flags.apiversion as string,
    });

    await tracking.ensureRemoteTracking(true);

    if (!this.flags.forceoverwrite) {
      const conflicts = await tracking.getConflicts();
      if (conflicts.length > 0) {
        writeConflictTable(conflicts, this.ux);
        throw new Error('conflicts detected');
      }
    }

    const retrieveResult = await tracking.retrieveRemoteChanges({ wait: this.flags.wait as Duration });

    if (!this.flags.json) {
      this.ux.logJson(retrieveResult);
    }
    return retrieveResult.map((fileResponse) => ({
      state: fileResponse.state,
      fullName: fileResponse.fullName,
      type: fileResponse.type,
      filePath: fileResponse.filePath,
    }));
  }
}
