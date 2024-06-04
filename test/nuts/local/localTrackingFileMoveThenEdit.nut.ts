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
import { ProjectJson } from '@salesforce/schemas';
import { NamedPackageDir, PackageDir } from '@salesforce/core';
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
    // await session?.clean();
  });

  it('initialize the local tracking', async () => {
    expect(typeof process.env.SF_BETA_TRACK_FILE_MOVES).to.equal('undefined');
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';

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

    delete process.env.SF_BETA_TRACK_FILE_MOVES;
  });
});
