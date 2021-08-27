/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { unlink } from 'fs/promises';
import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';

import { SfdxProject, Org } from '@salesforce/core';
import { ComponentSet, ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { writeConflictTable } from '../../writeConflictTable';
import { SourceTracking, ChangeResult } from '../../sourceTracking';

export default class SourcePull extends SfdxCommand {
  public static description = 'get local changes';
  protected static readonly flagsConfig: FlagsConfig = {
    forceoverwrite: flags.boolean({ char: 'f', description: 'overwrite files without prompting' }),
  };
  protected static requiresUsername = true;
  protected static requiresProject = true;
  protected project!: SfdxProject;
  protected org!: Org;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async run(): Promise<any> {
    this.ux.startSpinner('Initializing source tracking');
    const tracking = new SourceTracking({
      org: this.org,
      project: this.project,
    });

    await tracking.ensureRemoteTracking();
    const remoteChangesToPull = await tracking.getRemoteChanges();
    if (remoteChangesToPull.length === 0) {
      this.ux.stopSpinner('No remote changes exist');
      return;
    }
    const componentSetFromRemoteChanges = new ComponentSet();
    this.ux.setSpinnerStatus('creating the retrieve request');

    if (!this.flags.forceoverwrite) {
      this.ux.setSpinnerStatus('checking for source conflicts');
      const conflicts = await tracking.getConflicts();
      if (conflicts.length > 0) {
        writeConflictTable(conflicts, this.ux);
        throw new Error('conflicts detected');
      }
    }

    const changesToDelete: ChangeResult[] = [];

    // separate the deletes (local operations only) and the non deletes (will need to retrieve before local operations)
    remoteChangesToPull.map((component) => {
      this.logger.debug(`adding ${component.type} ${component.name} to component set`);
      if (component.deleted) {
        changesToDelete.push({ ...component, origin: 'remote' });
      } else {
        componentSetFromRemoteChanges.add({ type: component.type, fullName: component.name });
      }
    });

    if (changesToDelete.length > 0) {
      this.ux.setSpinnerStatus('deleting remote changes locally');
      // build a component set of the deleted types
      const changesToDeleteWithFilePaths = tracking.populateFilePaths(changesToDelete);
      // delete the files
      const filenames = changesToDeleteWithFilePaths
        .map((change) => change.filenames as string[])
        .flat()
        .filter(Boolean);
      await Promise.all(filenames.map((filename) => unlink(filename)));
      await Promise.all([
        tracking.updateLocalTracking({ deletedFiles: filenames }),
        tracking.updateRemoteTracking(
          changesToDeleteWithFilePaths.map((change) => ({ type: change.type as string, name: change.name as string }))
        ),
      ]);
    }

    // we might skip this and do only local deletes!
    if (componentSetFromRemoteChanges.size === 0) {
      this.ux.stopSpinner('No remote adds/modifications to merge locally');
      return;
    }

    const mdapiRetrieve = await componentSetFromRemoteChanges.retrieve({
      usernameOrConnection: this.org.getUsername() as string,
      merge: true,
      output: this.project.getDefaultPackage().fullPath,
      apiVersion: (this.flags.apiversion ??
        (
          await this.project.resolveProjectConfig()
        ).sourceApiVersion ??
        this.configAggregator.getPropertyValue('apiVersion')) as string | undefined,
    });
    this.ux.setSpinnerStatus('waiting for the retrieve results');
    const retrieveResult = await mdapiRetrieve.pollStatus(1000);
    this.ux.setSpinnerStatus('updating source tracking files');

    const successes = retrieveResult
      .getFileResponses()
      .filter((fileResponse) => fileResponse.state !== ComponentStatus.Failed);

    this.logger.debug(
      'files received from the server are',
      successes.map((fileResponse) => fileResponse.filePath as string).filter(Boolean)
    );

    await Promise.all([
      // commit the local file changes that the retrieve modified
      tracking.updateLocalTracking({
        files: successes.map((fileResponse) => fileResponse.filePath as string).filter(Boolean),
      }),
      // calling with no metadata types gets the latest sourceMembers from the org
      tracking.updateRemoteTracking(
        successes.map((fileResponse) => ({ name: fileResponse.fullName, type: fileResponse.type }))
      ),
    ]);
    return retrieveResult.getFileResponses();
  }
}
