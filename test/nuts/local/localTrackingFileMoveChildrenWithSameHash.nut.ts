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

describe('can match files with the same hash when the have different parents ', () => {
  const registry = new RegistryAccess();
  let session: TestSession;
  let repo: ShadowRepo;
  let filesToSync: string[];

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'vivek-project'),
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
      packageDirs: [
        {
          path: path.join('sfdx-source', 'packaged'),
          name: 'packaged',
          fullPath: path.join(session.project.dir, 'sfdx-source', 'packaged'),
        },
        {
          path: path.join('sfdx-source', 'unsorted'),
          name: 'unsorted',
          fullPath: path.join(session.project.dir, 'sfdx-source', 'unsorted'),
        },
      ],
      registry,
    });
    await fs.promises.mkdir(path.join(session.project.dir, 'sfdx-source', 'unsorted', 'main', 'default', 'objects'), {
      recursive: true,
    });
  });

  it('should show 0 files in git status after moving them', async () => {
    // Commit the existing class files
    filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync });

    const topDir = path.join(session.project.dir, 'sfdx-source');
    // move all the classes to the new folder
    fs.renameSync(
      path.join(topDir, 'packaged', 'main', 'objects', 'Workbook__c'),
      path.join(topDir, 'unsorted', 'main', 'default', 'objects', 'Workbook__c')
    );

    fs.renameSync(
      path.join(topDir, 'packaged', 'main', 'objects', 'Workshop__c'),
      path.join(topDir, 'unsorted', 'main', 'default', 'objects', 'Workshop__c')
    );

    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(0);
  });

  it('should detect changes when SF_DISABLE_SOURCE_MOBILITY is set to true', async () => {
    // Set SF_DISABLE_SOURCE_MOBILITY to true to opt-out of source mobility
    process.env.SF_DISABLE_SOURCE_MOBILITY = 'true';

    // Commit the existing class files
    filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync });

    const topDir = path.join(session.project.dir, 'sfdx-source');
    // move all the classes to the new folder
    fs.renameSync(
      path.join(topDir, 'packaged', 'main', 'objects', 'Workbook__c'),
      path.join(topDir, 'unsorted', 'main', 'default', 'objects', 'Workbook__c')
    );

    fs.renameSync(
      path.join(topDir, 'packaged', 'main', 'objects', 'Workshop__c'),
      path.join(topDir, 'unsorted', 'main', 'default', 'objects', 'Workshop__c')
    );

    await repo.getStatus(true);

    // When source mobility is disabled, moving files should be detected as changes
    const changedFiles = await repo.getChangedFilenames();
    expect(changedFiles).to.be.an('array').with.lengthOf(2);

    // Clean up environment variable
    delete process.env.SF_DISABLE_SOURCE_MOBILITY;
  });
});
