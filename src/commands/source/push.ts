/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { SfdxProject, Org } from '@salesforce/core';
import { ComponentSet, FileResponse, ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { MetadataKeyPair, SourceTracking, stringGuard } from '../../sourceTracking';
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
      .populateTypesAndNames(
        (
          await Promise.all([
            tracking.getChanges({ origin: 'local', state: 'changed' }),
            tracking.getChanges({ origin: 'local', state: 'add' }),
          ])
        ).flat(),
        true
      )
      .map((change) => change.filenames)
      .flat();
    const deletes = tracking
      .populateTypesAndNames(await tracking.getChanges({ origin: 'local', state: 'delete' }), true)
      .map((change) => change.filenames)
      .flat();

    // create ComponentSet
    if (nonDeletes.length === 0 && deletes.length === 0) {
      this.ux.log('There are no changes to deploy');
      return [];
    }

    if (deletes.length > 0) {
      this.ux.warn(
        `Delete not yet implemented in SDR.  Would have deleted ${deletes.length > 0 ? deletes.join(',') : 'nothing'}`
      );
    }

    const componentSet = ComponentSet.fromSource({ fsPaths: nonDeletes.filter(stringGuard) });
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
    // and update the remote tracking
    const successComponentKeys = (
      Array.isArray(result.response.details.componentSuccesses)
        ? result.response.details.componentSuccesses
        : [result.response.details.componentSuccesses]
    )
      .map((success) =>
        success?.fullName && success?.componentType
          ? { name: success?.fullName, type: success?.componentType }
          : undefined
      )
      .filter(Boolean) as MetadataKeyPair[]; // we don't want package.xml

    // this includes polling for sourceMembers
    await tracking.updateRemoteTracking(successComponentKeys);
    return result.getFileResponses();
  }
}
