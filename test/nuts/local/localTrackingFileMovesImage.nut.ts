/*
 * Copyright 2025, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'node:path';
import * as fs from 'graceful-fs';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
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

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
      registry,
    });
  });

  it('should show 0 files (images) in git status after moving them', async () => {
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
