/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { fs } from '@salesforce/core';
import { expect } from 'chai';
import { ShadowRepo } from '../../src/shared/localShadowRepo';

describe('verifies exact match of pkgDirs', () => {
  let session: TestSession;
  let repo: ShadowRepo;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ignoreInSubfolder', 'extra-classes'),
      },
      authStrategy: 'NONE',
    });
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId3',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
    });
    // verify the local tracking files/directories
    expect(fs.existsSync(repo.gitDir));
  });

  it('should not include files from force-app-extra', async () => {
    const changedFilenames = await repo.getChangedFilenames();

    // expect(changedFilenames).to.be.an('array').with.length(2);
    changedFilenames.map((f) => {
      expect(f).to.not.contain('force-app-extra');
    });
  });

  after(async () => {
    await session?.clean();
  });
});
