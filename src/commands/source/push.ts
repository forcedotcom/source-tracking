/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { SfdxProject, Org } from '@salesforce/core';
import { ComponentSet, FileResponse, ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { SourceTracking, stringGuard } from '../../sourceTracking';
import { writeConflictTable } from '../../writeConflictTable';
export default class SourcePush extends SfdxCommand {
  public static description = 'get local changes';
  protected static readonly flagsConfig: FlagsConfig = {
    forceoverwrite: flags.boolean({ char: 'f', description: 'overwrite files without prompting' }),
  };
  protected static requiresUsername = true;
  protected static requiresProject = true;
  protected project!: SfdxProject;
  protected org!: Org;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async run(): Promise<FileResponse[]> {
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
    // give me the deletes and nonDeletes in parallel
    // const [deletes, nonDeletes] = await Promise.all([
    //   tracking.getChanges({ origin: 'local', state: 'delete' }),
    //   tracking.getChanges({ origin: 'local', state: 'changed' }),
    // ]);
    await tracking.ensureLocalTracking();
    const nonDeletes = tracking
      // populateTypesAndNames is used to make sure the filenames could be deployed (that they are resolvable in SDR)
      .populateTypesAndNames({
        elements: (
          await Promise.all([
            tracking.getChanges({ origin: 'local', state: 'changed' }),
            tracking.getChanges({ origin: 'local', state: 'add' }),
          ])
        ).flat(),
        excludeUnresolvable: true,
      })
      .map((change) => change.filenames)
      .flat();
    const deletes = tracking
      .populateTypesAndNames({
        elements: await tracking.getChanges({ origin: 'local', state: 'delete' }),
        excludeUnresolvable: true,
      })
      .map((change) => change.filenames)
      .flat();

    // create ComponentSet
    if (nonDeletes.length === 0 && deletes.length === 0) {
      this.ux.log('There are no changes to deploy');
      return [];
    }

    const componentSet = ComponentSet.fromSource({
      fsPaths: nonDeletes.filter(stringGuard),
      fsDeletePaths: deletes.filter(stringGuard),
    });
    const deploy = await componentSet.deploy({ usernameOrConnection: this.org.getUsername() as string });
    const result = await deploy.pollStatus();

    const successes = result.getFileResponses().filter((fileResponse) => fileResponse.state !== ComponentStatus.Failed);
    // then commit successes to local tracking;
    await tracking.updateLocalTracking({
      files: successes.map((fileResponse) => fileResponse.filePath) as string[],
    });
    if (!this.flags.json) {
      this.ux.logJson(result.response);
    }

    // this includes polling for sourceMembers
    await tracking.updateRemoteTracking(successes);
    return result.getFileResponses();
  }
}
