/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
// import * as path from 'path';
import { EOL } from 'os';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { fs } from '@salesforce/core';
import { expect } from 'chai';
import { shouldThrow } from '@salesforce/core/lib/testSetup';
import { ShadowRepo } from '../../src/shared/repo';

describe('end-to-end-test', () => {
  let session: TestSession;
  let repo: ShadowRepo;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: 'test/nuts/ebikes-lwc',
      },
      authStrategy: 'NONE',
    });
  });

  after(async () => {
    await session?.clean();
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.create({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: undefined, fullPath: undefined }],
    });
    // verify the local tracking files/directories
    expect(fs.existsSync(repo.gitDir));
  });

  it('should return all the files in the project', async () => {
    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.length.greaterThan(50);
  });

  it('should commit the project with session-relative filenames and a message', async () => {
    expect(
      await repo.commitChanges({
        deployedFiles: await repo.getChangedFilenames(),
        message: 'test commit message',
      })
    ).to.be.a('string');
  });

  it('should see no changes after commit (and reconnect to repo)', async () => {
    // recreate the repo because we want it to not use cached status
    repo = await ShadowRepo.create({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: undefined, fullPath: undefined }],
    });
    // verify the local tracking files/directories
    expect(fs.existsSync(repo.gitDir));
    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.length(0);
  });

  it('should see modified file in changes', async () => {
    const filename = 'force-app/main/default/permissionsets/ebikes.permissionset-meta.xml';
    const filePath = `${session.project.dir}/${filename}`;
    const newContent = `${await fs.readFile(filePath, 'utf8')}${EOL}<!--testcode-->`;
    await fs.writeFile(filePath, newContent);
    await repo.getStatus(true);
    expect(await repo.getChangedRows()).to.have.lengthOf(1);
    expect(await repo.getChangedFilenames()).to.deep.equal([filename]);
    expect(await repo.getNonDeletes()).to.have.lengthOf(1);
    expect(await repo.getNonDeleteFilenames()).to.deep.equal([filename]);
    expect(await repo.getDeletes()).to.have.lengthOf(0);
  });

  it('should also see deleted file in changes', async () => {
    // yep, that typo is in the real repo!
    const filename = 'force-app/main/default/objects/Account/listViews/All_Acounts.listView-meta.xml';
    const filePath = `${session.project.dir}/${filename}`;
    await fs.unlink(filePath);
    await repo.getStatus(true);
    expect(await repo.getChangedRows()).to.have.lengthOf(2);
    expect(await repo.getDeletes()).to.have.lengthOf(1);
    expect(await repo.getDeleteFilenames()).to.deep.equal([filename]);
  });

  it('should also see added file in changes', async () => {
    const filename = 'force-app/main/default/objects/Account/listViews/Test.listView-meta.xml';
    const filePath = `${session.project.dir}/${filename}`;
    const newContent = '<!--testcode-->';
    await fs.writeFile(filePath, newContent);
    await repo.getStatus(true);
    expect(await repo.getChangedRows()).to.have.lengthOf(3);
    expect(await repo.getChangedFilenames()).to.include(filename);
    expect(await repo.getDeletes()).to.have.lengthOf(1);
  });

  it('changes remain after bad commit (simulate a failed deploy)', async () => {
    try {
      await shouldThrow(repo.commitChanges({ deployedFiles: ['badFilename'] }));
    } catch (err) {
      await repo.getStatus(true);
      expect(await repo.getChangedRows()).to.have.lengthOf(3);
      expect(await repo.getChangedFilenames()).to.have.lengthOf(3);
      expect(await repo.getDeletes()).to.have.lengthOf(1);
      expect(await repo.getNonDeletes()).to.have.lengthOf(2);
    }
  });
  it('changes are gone after a good commit (simulate a successful deploy)', async () => {
    expect(
      await repo.commitChanges({
        deployedFiles: await repo.getNonDeleteFilenames(),
        deletedFiles: await repo.getDeleteFilenames(),
        message: 'test commit message',
      })
    ).to.be.a('string');
    await repo.getStatus(true);

    expect(await repo.getChangedRows()).to.have.lengthOf(0);
  });
});
