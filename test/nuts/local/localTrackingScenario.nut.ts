/*
 * Copyright 2026, Salesforce, Inc.
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
import { EOL } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { shouldThrow } from '@salesforce/core/testSetup';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';

describe('end-to-end-test for local tracking', () => {
  let session: TestSession;
  let repo: ShadowRepo;

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

  it('commits no changes when there are none to commit', async () => {
    expect(
      await repo.commitChanges({
        deployedFiles: await repo.getChangedFilenames(),
        message: 'test commit message',
      })
    ).to.equal('no files to commit');
  });

  it('should see no changes after commit (and reconnect to repo)', async () => {
    // verify the local tracking files/directories
    expect(fs.existsSync(repo.gitDir));
    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.length(0);
  });

  it('should see modified file in changes', async () => {
    const filename = path.normalize('force-app/main/default/permissionsets/ebikes.permissionset-meta.xml');
    const filePath = path.normalize(path.join(session.project.dir, filename));
    const newContent = `${await fs.promises.readFile(filePath, 'utf8')}${EOL}<!--testcode-->`;
    await fs.promises.writeFile(filePath, newContent);
    await repo.getStatus(true);
    expect(await repo.getChangedRows()).to.have.lengthOf(1);
    expect(await repo.getModifyFilenames()).to.deep.equal([filename]);
    expect(await repo.getChangedFilenames()).to.deep.equal([path.normalize(filename)]);
    expect(await repo.getNonDeletes()).to.have.lengthOf(1);
    expect(await repo.getNonDeleteFilenames()).to.deep.equal([path.normalize(filename)]);
    expect(await repo.getDeletes()).to.have.lengthOf(0);
  });

  it('should also see deleted file in changes', async () => {
    // yep, that typo is in the real repo!
    const filename = 'force-app/main/default/objects/Account/listViews/All_Acounts.listView-meta.xml';
    const filePath = path.normalize(path.join(session.project.dir, filename));
    await fs.promises.unlink(filePath);
    await repo.getStatus(true);
    expect(await repo.getChangedRows()).to.have.lengthOf(2);
    expect(await repo.getDeletes()).to.have.lengthOf(1);
    expect(await repo.getDeleteFilenames()).to.deep.equal([path.normalize(filename)]);
  });

  it('should also see added file in changes', async () => {
    const filename = path.normalize('force-app/main/default/objects/Account/listViews/Test.listView-meta.xml');
    const filePath = path.normalize(path.join(session.project.dir, filename));
    const newContent = '<!--testcode-->';
    await fs.promises.writeFile(filePath, newContent);
    await repo.getStatus(true);
    expect(await repo.getChangedRows()).to.have.lengthOf(3);
    expect(await repo.getChangedFilenames()).to.include(path.normalize(filename));
    expect(await repo.getDeletes()).to.have.lengthOf(1);
    expect(await repo.getAdds()).to.have.lengthOf(1);
    expect(await repo.getAddFilenames()).to.deep.equals([filename]);
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

  it('can delete the local change files', async () => {
    const deleteResult = await repo.delete();
    expect(deleteResult).to.equal(repo.gitDir);
    expect(fs.existsSync(repo.gitDir)).to.equal(false);
  });
});
