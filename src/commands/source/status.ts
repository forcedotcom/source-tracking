/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { SfdxProject, Org } from '@salesforce/core';

import { ChangeResult, SourceTracking } from '../../sourceTracking';
export interface StatusResult {
  state: string;
  fullName: string;
  type: string;
  filePath?: string;
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

  protected localAdds: ChangeResult[] = [];

  public async run(): Promise<StatusResult[]> {
    this.logger.debug(
      `project is ${this.project.getPath()} and pkgDirs are ${this.project
        .getPackageDirectories()
        .map((dir) => dir.path)
        .join(',')}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracking = new SourceTracking({
      org: this.org,
      project: this.project,
    });
    let outputRows: StatusResult[] = [];

    if (this.flags.local || this.flags.all || (!this.flags.remote && !this.flags.all)) {
      await tracking.ensureLocalTracking();
      const [localDeletes, localModifies, localAdds] = (
        await Promise.all([
          tracking.getChanges({ origin: 'local', state: 'delete' }),
          tracking.getChanges({ origin: 'local', state: 'changed' }),
          tracking.getChanges({ origin: 'local', state: 'add' }),
        ])
      )
        // we don't get type/name on local changes unless we request them
        .map((changes) => tracking.populateTypesAndNames(changes));
      outputRows = outputRows.concat(localAdds.map((item) => this.statusResultToOutputRows(item, 'add')).flat());
      outputRows = outputRows.concat(
        localModifies.map((item) => this.statusResultToOutputRows(item, 'changed')).flat()
      );
      outputRows = outputRows.concat(localDeletes.map((item) => this.statusResultToOutputRows(item, 'delete')).flat());
    }

    if (this.flags.remote || this.flags.all || (!this.flags.local && !this.flags.all)) {
      await tracking.ensureRemoteTracking();
      const [remoteDeletes, remoteModifies] = await Promise.all([
        tracking.getChanges({ origin: 'remote', state: 'delete' }),
        tracking.getChanges({ origin: 'remote', state: 'changed' }),
      ]);
      outputRows = outputRows.concat(remoteDeletes.map((item) => this.statusResultToOutputRows(item)).flat());
      outputRows = outputRows.concat(
        remoteModifies
          .filter((item) => item.modified)
          .map((item) => this.statusResultToOutputRows(item))
          .flat()
      );
      outputRows = outputRows.concat(
        remoteModifies
          .filter((item) => !item.modified)
          .map((item) => this.statusResultToOutputRows(item))
          .flat()
      );
    }

    if (!this.flags.local && !this.flags.remote) {
      // a flat array of conflict filenames
      const conflictFilenames = (await tracking.getConflicts()).map((conflict) => conflict.filenames).flat();
      if (conflictFilenames.length > 0) {
        outputRows.map((row) =>
          conflictFilenames.includes(row.filePath) ? { ...row, state: `${row.state} (Conflict)` } : row
        );
      }
    }

    this.ux.table(outputRows, {
      columns: [
        { label: 'STATE', key: 'state' },
        { label: 'FULL NAME', key: 'fullName' },
        { label: 'TYPE', key: 'type' },
        { label: 'PROJECT PATH', key: 'filepath' },
      ],
    });

    // convert things into the output format to match the existing command
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
      type: input.type || 'TODO',
      state: `${input.origin} ${state()}`,
      fullName: input.name || 'TODO',
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
