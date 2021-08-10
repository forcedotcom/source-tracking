/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { FlagsConfig, flags, SfdxCommand } from '@salesforce/command';
import { SfdxProject, Org } from '@salesforce/core';
import { ComponentSet, FileResponse } from '@salesforce/source-deploy-retrieve';

import { SourceTracking } from '../../sourceTracking';

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
      orgId: this.org.getOrgId(),
      projectPath: this.project.getPath(),
      packageDirs: this.project.getPackageDirectories(),
    });
    if (!this.flags.forceoverwrite) {
      // TODO: check for conflicts
    }
    // give me the deletes and nonDeletes
    // const [deletes, nonDeletes] = await Promise.all([
    //   tracking.getChanges({ origin: 'local', state: 'delete' }),
    //   tracking.getChanges({ origin: 'local', state: 'changed' }),
    // ]);
    const nonDeletes = await tracking.getChanges({ origin: 'local', state: 'changed' });
    const deletes = await tracking.getChanges({ origin: 'local', state: 'delete' });

    this.ux.warn(
      `Delete not yet implemented in SDR.  Would have deleted ${deletes.length > 0 ? deletes.join(',') : 'nothing'}`
    );
    // create ComponentSet
    if (nonDeletes.length === 0) {
      this.ux.log('There are no changes to deploy');
      return [];
    }
    this.ux.log(`should build component set from ${nonDeletes.join(',')}`);
    const componentSet = ComponentSet.fromSource(nonDeletes);
    // this.ux.logJson(componentSet.getSourceComponents());
    const deploy = await componentSet.deploy({ usernameOrConnection: this.org.getUsername() as string });
    const result = await deploy.pollStatus();

    // then commit to local tracking;
    await tracking.update({ files: result.getFileResponses().map((file) => file.filePath) as string[] });
    return result.getFileResponses();
    // return [];
  }
}
