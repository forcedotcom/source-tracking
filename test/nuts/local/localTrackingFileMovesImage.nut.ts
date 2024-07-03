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
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';

/* eslint-disable no-unused-expressions */

describe('it detects image file moves ', () => {
  const registry = new RegistryAccess();
  let session: TestSession;
  let repo: ShadowRepo;
  let filesToSync: string[];
  let staticDir: string;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
      },
      devhubAuthStrategy: 'NONE',
    });
    staticDir = path.join(session.project.dir, 'force-app', 'main', 'default', 'staticresources');
  });

  after(async () => {
    await session?.clean();
  });

  afterEach(() => {
    delete process.env.SF_BETA_TRACK_FILE_MOVES;
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
      registry,
    });
  });

  it('should show 0 files (images) in git status after moving them', async () => {
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';
    // Commit the existing class files
    filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync });

    // move all the classes to the new folder
    fs.mkdirSync(path.join(staticDir, 'bike_assets_new'), {
      recursive: true,
    });
    fs.renameSync(
      path.join(staticDir, 'bike_assets', 'CyclingGrass.jpg'),
      path.join(staticDir, 'bike_assets_new', 'CyclingGrass.jpg')
    );

    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(0);
  });
});
