/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { ShadowRepo } from '../../../src/shared/localShadowRepo';

describe('perf testing for big commits', () => {
  let session: TestSession;
  let repo: ShadowRepo;
  let filesToSync: string[];

  before(async () => {
    session = await TestSession.create({
      project: {
        gitClone: 'https://github.com/SalesforceFoundation/EDA',
      },
      devhubAuthStrategy: 'NONE',
    });
  });

  after(async () => {
    await session?.clean();
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
    });
  });

  it('should find a lot of files', async () => {
    filesToSync = await repo.getChangedFilenames();
    expect(filesToSync).to.be.an('array').with.length.greaterThan(1000);
  });

  it('should sync them locally in a reasonable amount of time', async () => {
    const start = Date.now();
    await repo.commitChanges({ deployedFiles: filesToSync, needsUpdatedStatus: false });
    expect(Date.now() - start).to.be.lessThan(15000);
  });
});
