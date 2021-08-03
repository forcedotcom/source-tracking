/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'path';

import {
  // flags,
  SfdxCommand,
} from '@salesforce/command';
// import { SfdxError } from '@salesforce/core';
import { AnyJson } from '@salesforce/ts-types';
import { fs } from '@salesforce/core';

import { Repository } from 'nodegit';
import { getRepoPath } from '../../lib/repo';

export default class SourceInit extends SfdxCommand {
  public static description = 'initiate Source Tracking';
  protected static flagsConfig = {};
  protected static requiresUsername = true;
  protected static requiresProject = true;

  public async run(): Promise<AnyJson> {
    const repoPath = await getRepoPath();
    const gitDir = path.join(repoPath, '.sfdx', 'orgs', this.org.getOrgId());
    await fs.mkdirp(gitDir);
    await Repository.initExt(gitDir, {
      description: 'sfdx-source-tracking',
      flags: null,
      mode: null,
      workdirPath: '.',
      version: null,
      templatePath: null,
      originUrl: null,
      initialHead: 'main',
    });
    return undefined;
  }
}
