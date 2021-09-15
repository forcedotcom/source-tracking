/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags } from '@salesforce/command';
import { Duration, env } from '@salesforce/kit';
import { SfdxProject, Org, Messages, SfdxError } from '@salesforce/core';
import { RequestStatus, ComponentStatus } from '@salesforce/source-deploy-retrieve';

// TODO: move to plugin-source
import { DeployCommand } from '@salesforce/plugin-source/lib/deployCommand';
import {
  DeployResultFormatter,
  DeployCommandResult,
} from '@salesforce/plugin-source/lib/formatters/DeployResultFormatter';
import { ProgressFormatter } from '@salesforce/plugin-source/lib/formatters/progressFormatter';
import { DeployProgressBarFormatter } from '@salesforce/plugin-source/lib/formatters/deployProgressBarFormatter';
import { DeployProgressStatusFormatter } from '@salesforce/plugin-source/lib/formatters/deployProgressStatusFormatter';

import { SourceTracking } from '../../../sourceTracking';
import { writeConflictTable } from '../../../writeConflictTable';
import { throwIfInvalid } from '../../../compatibility';

Messages.importMessagesDirectory(__dirname);
const messages: Messages = Messages.loadMessages('@salesforce/source-tracking', 'source_push');

export default class SourcePush extends DeployCommand {
  public static description = messages.getMessage('commandDescription');
  public static help = messages.getMessage('commandHelp');
  protected static readonly flagsConfig: FlagsConfig = {
    forceoverwrite: flags.boolean({
      char: 'f',
      description: messages.getMessage('forceoverwriteFlagDescription'),
      longDescription: messages.getMessage('forceoverwriteFlagDescriptionLong'),
    }),
    // TODO: use shared flags from plugin-source?
    wait: flags.minutes({
      char: 'w',
      default: Duration.minutes(33),
      min: Duration.minutes(1),
      description: messages.getMessage('waitFlagDescriptionLong'),
      longDescription: messages.getMessage('waitFlagDescriptionLong'),
    }),
    ignorewarnings: flags.boolean({
      char: 'g',
      description: messages.getMessage('ignorewarningsFlagDescription'),
      longDescription: messages.getMessage('ignorewarningsFlagDescriptionLong'),
    }),
  };
  protected static requiresUsername = true;
  protected static requiresProject = true;
  protected readonly lifecycleEventNames = ['predeploy', 'postdeploy'];

  protected project!: SfdxProject; // ok because requiresProject
  protected org!: Org; // ok because requiresUsername

  private isRest = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async run(): Promise<DeployCommandResult> {
    await this.deploy();
    this.resolveSuccess();
    return this.formatResult();
  }

  protected async deploy(): Promise<void> {
    throwIfInvalid({
      org: this.org,
      projectPath: this.project.getPath(),
      toValidate: 'plugin-source',
      command: 'beta:source:push',
    });
    const waitDuration = this.getFlag<Duration>('wait');
    this.isRest = await this.isRestDeploy();

    const tracking = await SourceTracking.create({
      org: this.org,
      project: this.project,
      apiVersion: this.flags.apiversion as string,
    });
    if (!this.flags.forceoverwrite) {
      const conflicts = await tracking.getConflicts();
      if (conflicts.length > 0) {
        writeConflictTable(conflicts, this.ux);
        throw new SfdxError(messages.getMessage('pushCommandConflictMsg'));
      }
    }
    const componentSet = await tracking.localChangesAsComponentSet();

    // there might have been components in local tracking, but they might be ignored by SDR or unresolvable.
    // SDR will throw when you try to resolve them, so don't
    if (componentSet.size === 0) {
      this.logger.warn('There are no changes to deploy');
      return;
    }

    // fire predeploy event for sync and async deploys
    await this.lifecycle.emit('predeploy', componentSet.toArray());
    this.ux.log(`*** Deploying with ${this.isRest ? 'REST' : 'SOAP'} API ***`);

    const deploy = await componentSet.deploy({
      usernameOrConnection: this.org.getUsername() as string,
      apiOptions: { ignoreWarnings: (this.flags.ignoreWarnings as boolean) || false, rest: this.isRest },
    });

    // we're not print JSON output
    if (!this.isJsonOutput()) {
      const progressFormatter: ProgressFormatter = env.getBoolean('SFDX_USE_PROGRESS_BAR', true)
        ? new DeployProgressBarFormatter(this.logger, this.ux)
        : new DeployProgressStatusFormatter(this.logger, this.ux);
      progressFormatter.progress(deploy);
    }
    this.deployResult = await deploy.pollStatus(500, waitDuration.seconds);

    const successes = this.deployResult
      .getFileResponses()
      .filter((fileResponse) => fileResponse.state !== ComponentStatus.Failed);
    const successNonDeletes = successes.filter((fileResponse) => fileResponse.state !== ComponentStatus.Deleted);
    const successDeletes = successes.filter((fileResponse) => fileResponse.state === ComponentStatus.Deleted);

    await Promise.all([
      // Only fire the postdeploy event when we have results. I.e., not async.
      this.deployResult ? this.lifecycle.emit('postdeploy', this.deployResult) : Promise.resolve(),
      tracking.updateLocalTracking({
        files: successNonDeletes.map((fileResponse) => fileResponse.filePath) as string[],
        deletedFiles: successDeletes.map((fileResponse) => fileResponse.filePath) as string[],
      }),
      tracking.updateRemoteTracking(successes),
    ]);
  }

  protected resolveSuccess(): void {
    // there might not be a deployResult if we exited early with an empty componentSet
    if (this.deployResult && this.deployResult.response.status !== RequestStatus.Succeeded) {
      this.setExitCode(1);
    }
  }

  protected formatResult(): DeployCommandResult {
    if (!this.deployResult) {
      this.ux.log('No results found');
    }
    const formatterOptions = {
      verbose: this.getFlag<boolean>('verbose', false),
    };

    const formatter = new DeployResultFormatter(this.logger, this.ux, formatterOptions, this.deployResult);

    // Only display results to console when JSON flag is unset.
    if (!this.isJsonOutput()) {
      formatter.display();
    }

    return formatter.getJson();
  }
}
