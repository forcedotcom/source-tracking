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
// import { SfdxError } from '@salesforce/core';
import { AnyJson } from '@salesforce/ts-types';
import { ShadowRepo } from '../../shared/repo';

export default class SourceInit extends SfdxCommand {
  public static description = 'initiate Source Tracking';
  protected static flagsConfig = {};
  protected static requiresUsername = true;
  protected static requiresProject = true;

  public async run(): Promise<AnyJson> {
    const shadowRepo = await ShadowRepo.create({
      orgId: this.org.getOrgId(),
      projectPath: this.project.getPath(),
      packageDirs: this.project.getPackageDirectories(),
    });
    await shadowRepo.gitInit();

    this.ux.log(`initialized git repo for ${shadowRepo.projectPath} in ${shadowRepo.gitDir}`);
    return {};
  }
}
