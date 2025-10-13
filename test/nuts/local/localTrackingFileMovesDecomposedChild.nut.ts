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

import * as path from 'node:path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import fs from 'graceful-fs';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo.js';

/* eslint-disable no-unused-expressions */

describe('ignores moved files that are children of a decomposed metadata type', () => {
  const FIELD = path.join('fields', 'Account__c.field-meta.xml');
  let session: TestSession;
  let repo: ShadowRepo;
  let objectsDir: string;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
      },
      devhubAuthStrategy: 'NONE',
    });
    objectsDir = path.join(session.project.dir, 'force-app', 'main', 'default', 'objects');
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
    // Commit the existing files
    const filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync });
    // move the field from one object to another
    const objectFieldOld = path.join(objectsDir, 'Order__c', FIELD);
    const objectFieldNew = path.join(objectsDir, 'Product__c', FIELD);
    fs.renameSync(objectFieldOld, objectFieldNew);

    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(2);

    // put it back how it was and verify the tracking
    fs.renameSync(objectFieldNew, objectFieldOld);
    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(0);
  });

  it('should clear tracking when the field is moved to another dir', async () => {
    const newDir = path.join(session.project.dir, 'force-app', 'other', 'objects', 'Order__c', 'fields');
    await fs.promises.mkdir(newDir, {
      recursive: true,
    });
    const objectFieldOld = path.join(objectsDir, 'Order__c', FIELD);
    const objectFieldNew = path.join(objectsDir, 'Order__c', FIELD);
    fs.renameSync(objectFieldOld, objectFieldNew);
    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(0);
  });
});
