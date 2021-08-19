/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { flags, FlagsConfig, SfdxCommand } from '@salesforce/command';
import { Messages, Org, SfdxProject } from '@salesforce/core';
import * as chalk from 'chalk';
import { SourceTracking } from '../../../sourceTracking';

Messages.importMessagesDirectory(__dirname);
const messages: Messages = Messages.loadMessages('@salesforce/source-tracking', 'source_tracking');

export type SourceTrackingResetResult = {
  sourceMembersSynced: number;
  localPathsSynced: number;
};

export class SourceTrackingResetCommand extends SfdxCommand {
  public static readonly description = messages.getMessage('resetDescription');

  public static readonly requiresProject = true;
  public static readonly requiresUsername = true;

  public static readonly flagsConfig: FlagsConfig = {
    revision: flags.integer({
      char: 'r',
      description: messages.getMessage('revisionDescription'),
      min: 0,
    }),
    noprompt: flags.boolean({
      char: 'p',
      description: messages.getMessage('nopromptDescription'),
    }),
  };

  // valid assertions with ! because requiresProject and requiresUsername
  protected org!: Org;
  protected project!: SfdxProject;

  public async run(): Promise<SourceTrackingResetResult> {
    if (this.flags.noprompt || (await this.ux.confirm(chalk.dim(messages.getMessage('promptMessage'))))) {
      const sourceTracking = new SourceTracking({ project: this.project, org: this.org });

      const [remoteResets, localResets] = await Promise.all([
        sourceTracking.resetRemoteTracking(this.flags.revision as number),
        sourceTracking.resetLocalTracking(),
      ]);

      this.ux.log(
        `Reset local tracking files${this.flags.revision ? ` to revision ${this.flags.revision as number}` : ''}.`
      );

      return {
        sourceMembersSynced: remoteResets,
        localPathsSynced: localResets.length,
      };
    }

    return {
      sourceMembersSynced: 0,
      localPathsSynced: 0,
    };
  }
}
