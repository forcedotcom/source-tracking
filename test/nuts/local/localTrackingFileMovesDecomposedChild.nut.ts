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

describe('ignores moved files that are children of a decomposed metadata type', () => {
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
      registry: new RegistryAccess(),
    });
  });

  it('should ignore moved child metadata', async () => {
    expect(process.env.SF_BETA_TRACK_FILE_MOVES).to.be.undefined;
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';
    // Commit the existing class files
    filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync });

    // move all the classes to the new folder
    const objectFieldOld = path.join(
      session.project.dir,
      'force-app',
      'main',
      'default',
      'objects',
      'Order__c',
      'fields',
      'Account__c.field-meta.xml'
    );
    const objectFieldNew = path.join(
      session.project.dir,
      'force-app',
      'main',
      'default',
      'objects',
      'Product__c',
      'fields',
      'Account__c.field-meta.xml'
    );
    // fs.mkdirSync(path.join(session.project.dir, 'force-app', 'main', 'foo'), { recursive: true });
    fs.renameSync(objectFieldOld, objectFieldNew);

    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(2);

    delete process.env.SF_BETA_TRACK_FILE_MOVES;
  });
});
