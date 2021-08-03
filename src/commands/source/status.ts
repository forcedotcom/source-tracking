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
import { getRepo } from '../../lib/repo';

export default class SourceStatus extends SfdxCommand {
  public static description = 'get local changes';
  protected static flagsConfig = {};
  protected static requiresUsername = true;
  protected static requiresProject = true;

  public async run(): Promise<AnyJson> {
    const repo = await getRepo(this.org.getOrgId());
    const status = await repo.getStatus();
    this.ux.logJson(status);
    return undefined;
  }
}
