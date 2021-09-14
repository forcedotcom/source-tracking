/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { EOL } from 'os';
import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { SfdxProject, Org, Messages } from '@salesforce/core';
import { getKeyFromStrings } from '../../..';

import { ChangeResult, SourceTracking, getKeyFromObject } from '../../../sourceTracking';
export interface StatusResult {
  state: string;
  fullName: string;
  type: string;
  filePath?: string;
}

Messages.importMessagesDirectory(__dirname);
const messages: Messages = Messages.loadMessages('@salesforce/source-tracking', 'status');

export default class SourceStatus extends SfdxCommand {
  public static description = messages.getMessage('statusCommandCliDescription');
  public static readonly examples = messages.getMessage('examples').split(EOL);
  protected static flagsConfig: FlagsConfig = {
    all: flags.boolean({
      char: 'a',
      description: messages.getMessage('statusCommandAllOptionDescription'),
      longDescription: messages.getMessage('statusCommandAllOptionDescriptionLong'),
    }),
    local: flags.boolean({
      char: 'l',
      description: messages.getMessage('statusCommandLocalOptionDescription'),
      longDescription: messages.getMessage('statusCommandLocalOptionDescriptionLong'),
    }),
    remote: flags.boolean({
      char: 'r',
      description: messages.getMessage('statusCommandRemoteOptionDescription'),
      longDescription: messages.getMessage('statusCommandRemoteOptionDescriptionLong'),
    }),
  };
  protected static requiresUsername = true;
  protected static requiresProject = true;
  protected project!: SfdxProject;
  protected org!: Org;

  protected localAdds: ChangeResult[] = [];

  public async run(): Promise<StatusResult[]> {
    const wantsLocal =
      (this.flags.local as boolean) || (this.flags.all as boolean) || (!this.flags.remote && !this.flags.all);
    const wantsRemote =
      (this.flags.remote as boolean) || (this.flags.all as boolean) || (!this.flags.local && !this.flags.all);

    this.logger.debug(
      `project is ${this.project.getPath()} and pkgDirs are ${this.project
        .getPackageDirectories()
        .map((dir) => dir.path)
        .join(',')}`
    );
    const tracking = await SourceTracking.create({
      org: this.org,
      project: this.project,
      apiVersion: this.flags.apiversion as string,
    });
    let outputRows: StatusResult[] = [];

    if (wantsLocal) {
      await tracking.ensureLocalTracking();
      const localDeletes = tracking.populateTypesAndNames({
        elements: await tracking.getChanges<ChangeResult>({ origin: 'local', state: 'delete', format: 'ChangeResult' }),
        excludeUnresolvable: true,
        resolveDeleted: true,
      });

      const localAdds = tracking.populateTypesAndNames({
        elements: await tracking.getChanges<ChangeResult>({ origin: 'local', state: 'add', format: 'ChangeResult' }),
        excludeUnresolvable: true,
      });

      const localModifies = tracking.populateTypesAndNames({
        elements: await tracking.getChanges<ChangeResult>({ origin: 'local', state: 'modify', format: 'ChangeResult' }),
        excludeUnresolvable: true,
      });

      outputRows = outputRows.concat(localAdds.flatMap((item) => this.statusResultToOutputRows(item, 'add')));
      outputRows = outputRows.concat(localModifies.flatMap((item) => this.statusResultToOutputRows(item, 'changed')));
      outputRows = outputRows.concat(localDeletes.flatMap((item) => this.statusResultToOutputRows(item, 'delete')));
    }

    if (wantsRemote) {
      // by initializeWithQuery true, one query runs so that parallel getChanges aren't doing parallel queries
      await tracking.ensureRemoteTracking(true);
      const [remoteDeletes, remoteModifies] = await Promise.all([
        tracking.getChanges<ChangeResult>({ origin: 'remote', state: 'delete', format: 'ChangeResult' }),
        tracking.getChanges<ChangeResult>({ origin: 'remote', state: 'nondelete', format: 'ChangeResult' }),
      ]);
      outputRows = outputRows.concat(remoteDeletes.flatMap((item) => this.statusResultToOutputRows(item)));
      outputRows = outputRows.concat(remoteModifies.flatMap((item) => this.statusResultToOutputRows(item)));
    }

    if (wantsLocal && wantsRemote) {
      // keys like ApexClass__MyClass.cls
      const conflictKeys = (await tracking.getConflicts()).map((conflict) => getKeyFromObject(conflict));
      if (conflictKeys.length > 0) {
        outputRows = outputRows.map((row) =>
          conflictKeys.includes(getKeyFromStrings(row.type, row.fullName))
            ? { ...row, state: `${row.state} (Conflict)` }
            : row
        );
      }
    }
    // sort order is state, type, fullname
    outputRows.sort((a, b) => {
      if (a.state.toLowerCase() === b.state.toLowerCase()) {
        if (a.type.toLowerCase() === b.type.toLowerCase()) {
          return a.fullName.toLowerCase() < b.fullName.toLowerCase() ? -1 : 1;
        }
        return a.type.toLowerCase() < b.type.toLowerCase() ? -1 : 1;
      }
      return a.state.toLowerCase() < b.state.toLowerCase() ? -1 : 1;
    });
    this.ux.log(messages.getMessage('statusCommandHumanSuccess'));
    this.ux.table(outputRows, {
      columns: [
        { label: 'STATE', key: 'state' },
        { label: 'FULL NAME', key: 'fullName' },
        { label: 'TYPE', key: 'type' },
        { label: 'PROJECT PATH', key: 'filepath' },
      ],
    });

    return outputRows;
  }

  private statusResultToOutputRows(input: ChangeResult, localType?: 'delete' | 'changed' | 'add'): StatusResult[] {
    this.logger.debug('converting ChangeResult to a row', input);

    const state = (): string => {
      if (localType) {
        return localType[0].toUpperCase() + localType.substring(1);
      }
      if (input.deleted) {
        return 'Delete';
      }
      if (input.modified) {
        return 'Changed';
      }
      return 'Add';
    };
    const baseObject = {
      type: input.type ?? '',
      state: `${input.origin} ${state()}`,
      fullName: input.name ?? '',
    };
    this.logger.debug(baseObject);

    if (!input.filenames) {
      return [baseObject];
    }
    return input.filenames.map((filename) => ({
      ...baseObject,
      filepath: filename,
    }));
  }
}
