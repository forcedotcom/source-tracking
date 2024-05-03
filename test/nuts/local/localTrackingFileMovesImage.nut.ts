/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'node:path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import * as fs from 'graceful-fs';
import { ShadowRepo } from '../../../src/shared/localShadowRepo';

describe('it detects image file moves ', () => {
  let session: TestSession;
  let repo: ShadowRepo;
  let filesToSync: string[];

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
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

  it('should show 0 files (images) in git status after moving them', async () => {
    // Commit the existing class files
    filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync })

    // move all the classes to the new folder
    fs.mkdirSync(path.join(session.project.dir, 'force-app', 'main', 'default', 'staticresources', 'bike_assets_new'), { recursive: true });
    fs.renameSync(
      path.join(session.project.dir, 'force-app', 'main', 'default', 'staticresources', 'bike_assets', 'CyclingGrass.jpg'),
      path.join(session.project.dir, 'force-app', 'main', 'default', 'staticresources', 'bike_assets_new', 'CyclingGrass.jpg'),
    );

    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(0);
  });
});
