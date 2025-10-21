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
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import fs from 'graceful-fs';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ProjectJson } from '@salesforce/schemas';
import { NamedPackageDir } from '@salesforce/core';
import { PackageDir } from '@salesforce/schemas';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';

describe('handles local files moves that also change the file', () => {
  let session: TestSession;
  let repo: ShadowRepo;
  let modifiedPackageDirs: PackageDir[];
  const NOT_PROJECT_DIR = 'not-project-dir';
  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
      },
      devhubAuthStrategy: 'NONE',
    });
    // create the other dir
    const notProjectDir = path.join(session.project.dir, NOT_PROJECT_DIR, 'main', 'default', 'classes');
    await fs.promises.mkdir(notProjectDir, { recursive: true });

    // modify the project json to include the new dir
    const sfdxProjectJsonPath = path.join(session.project.dir, 'sfdx-project.json');
    const originalProject = JSON.parse(await fs.promises.readFile(sfdxProjectJsonPath, 'utf8')) as ProjectJson;
    modifiedPackageDirs = [...originalProject.packageDirectories, { path: NOT_PROJECT_DIR }];
    await fs.promises.writeFile(
      sfdxProjectJsonPath,
      JSON.stringify({
        ...originalProject,
        packageDirectories: modifiedPackageDirs,
      } satisfies ProjectJson)
    );
  });

  after(async () => {
    await session?.clean();
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: modifiedPackageDirs.map(
        (pd): NamedPackageDir => ({ ...pd, name: NOT_PROJECT_DIR, fullPath: path.join(session.project.dir, pd.path) })
      ),
      registry: new RegistryAccess(),
    });

    // Commit the existing status
    const filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync });

    expect(await repo.getChangedFilenames()).to.have.lengthOf(0);
  });

  it('move a file and edit it.  Only the delete is committed', async () => {
    // move all two classes to the new folder
    const classFolder = path.join('main', 'default', 'classes');
    ['OrderController.cls', 'OrderController.cls-meta.xml', 'PagedResult.cls', 'PagedResult.cls-meta.xml'].map((f) =>
      fs.renameSync(
        path.join(session.project.dir, 'force-app', classFolder, f),
        path.join(session.project.dir, NOT_PROJECT_DIR, classFolder, f)
      )
    );
    const editedFilePath = path.join(NOT_PROJECT_DIR, classFolder, 'OrderController.cls');
    // edit the contents of OrderController.cls
    fs.appendFileSync(path.join(session.project.dir, editedFilePath), '//comment');
    await repo.getStatus(true);

    // all the deletes were committed
    expect(await repo.getDeleteFilenames()).to.deep.equal([]);
    // this is still considered an "add" because the moved file was changed
    expect(await repo.getAddFilenames()).to.deep.equal([editedFilePath]);
  });
});
