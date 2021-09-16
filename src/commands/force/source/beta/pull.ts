/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { Duration } from '@salesforce/kit';
import { SfdxProject, Org, Messages } from '@salesforce/core';
import { processConflicts } from '../../../../conflicts';
import { SourceTracking } from '../../../../sourceTracking';
import { throwIfInvalid, replaceRenamedCommands } from '../../../../compatibility';

Messages.importMessagesDirectory(__dirname);
const messages: Messages = Messages.loadMessages('@salesforce/source-tracking', 'source_pull');

export default class SourcePull extends SfdxCommand {
  public static description = messages.getMessage('commandDescription');
  protected static readonly flagsConfig: FlagsConfig = {
    forceoverwrite: flags.boolean({
      char: 'f',
      description: messages.getMessage('forceoverwriteFlagDescription'),
      longDescription: messages.getMessage('forceoverwriteFlagDescriptionLong'),
    }),
    // TODO: use shared flags from plugin-source
    wait: flags.minutes({
      char: 'w',
      default: Duration.minutes(33),
      min: Duration.minutes(0), // wait=0 means deploy is asynchronous
      description: messages.getMessage('waitFlagDescriptionLong'),
      longDescription: messages.getMessage('waitFlagDescriptionLong'),
    }),
  };
  protected static requiresUsername = true;
  protected static requiresProject = true;
  protected project!: SfdxProject;
  protected org!: Org;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async run(): Promise<any> {
    throwIfInvalid({
      org: this.org,
      projectPath: this.project.getPath(),
      toValidate: 'plugin-source',
      command: replaceRenamedCommands('force:source:pull'),
    });

    this.ux.startSpinner('Loading source tracking information');
    const tracking = await SourceTracking.create({
      org: this.org,
      project: this.project,
      apiVersion: this.flags.apiversion as string,
    });

    await tracking.ensureRemoteTracking(true);
    this.ux.setSpinnerStatus('Checking for conflicts');

    if (!this.flags.forceoverwrite) {
      processConflicts(await tracking.getConflicts(), this.ux, messages.getMessage('sourceConflictDetected'));
    }

    this.ux.setSpinnerStatus('Retrieving metadata from the org');

    const retrieveResult = await tracking.retrieveRemoteChanges({ wait: this.flags.wait as Duration });
    this.ux.stopSpinner();
    if (!this.flags.json) {
      this.ux.table(retrieveResult, {
        columns: [
          { label: 'STATE', key: 'state' },
          { label: 'FULL NAME', key: 'fullName' },
          { label: 'TYPE', key: 'type' },
          { label: 'PROJECT PATH', key: 'filePath' },
        ],
      });
    }
    return retrieveResult.map(({ state, fullName, type, filePath }) => ({ state, fullName, type, filePath }));
  }
}