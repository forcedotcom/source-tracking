/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {
  // flags,
  SfdxCommand,
} from '@salesforce/command';
import { AnyJson } from '@salesforce/ts-types';
import { ShadowRepo } from '../../lib/repo';

export default class SourceCommit extends SfdxCommand {
  public static description = 'commit local changes';
  protected static flagsConfig = {};
  protected static requiresUsername = true;
  protected static requiresProject = true;

  public async run(): Promise<AnyJson> {
    this.ux.log(
      `project is ${this.project.getPath()} and pkgDirs are ${this.project
        .getPackageDirectories()
        .map((dir) => dir.path)
        .join(',')}`
    );

    const shadowRepo = await ShadowRepo.create({
      orgId: this.org.getOrgId(),
      projectPath: this.project.getPath(),
      packageDirs: this.project.getPackageDirectories(),
    });
    const sha = await shadowRepo.commitChanges();

    return sha;
  }
}
