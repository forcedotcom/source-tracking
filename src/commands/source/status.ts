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
import { ShadowRepo } from '../../shared/repo';

// array members for status results
// https://isomorphic-git.org/docs/en/statusMatrix#docsNav
const FILE = 0;
const HEAD = 1;
const WORKDIR = 2;

export default class SourceStatus extends SfdxCommand {
  public static description = 'get local changes';
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
    const changes = await shadowRepo.getChangedRows();

    const deletes = await shadowRepo.getDeleteFilenames();
    const modifies = changes.filter((file) => file[HEAD] === 1 && file[WORKDIR] === 2).map((file) => file[FILE]);
    const adds = changes.filter((file) => file[HEAD] === 0 && file[WORKDIR] === 2).map((file) => file[FILE]);
    const output = {
      deletes,
      adds,
      modifies,
    };
    return output;
  }
}
