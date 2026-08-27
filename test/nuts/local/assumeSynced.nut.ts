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
import path from 'node:path';
import fs from 'node:fs';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';

describe('SF_SOURCE_TRACKING_ASSUME_SYNCED (NUT)', () => {
  let session: TestSession;
  let repo: ShadowRepo;
  const registry = new RegistryAccess();

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
      },
      devhubAuthStrategy: 'NONE',
    });
  });

  after(async () => {
    delete process.env.SF_SOURCE_TRACKING_ASSUME_SYNCED;
    await session?.clean();
  });

  it('initializes shadow repo and sees real changes without env var', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'assumeSyncedNut',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
      registry,
    });

    const changes = await repo.getChangedFilenames();
    expect(changes).to.be.an('array').with.length.greaterThan(50);
  });

  it('commits all files to establish a clean baseline', async () => {
    const sha = await repo.commitChanges({
      deployedFiles: await repo.getChangedFilenames(),
      message: 'baseline commit',
    });
    expect(sha).to.be.a('string');
    expect(await repo.getChangedFilenames()).to.have.lengthOf(0);
  });

  it('with env var set, reports no changes even after file modifications', async () => {
    // modify a file
    const target = path.join(
      session.project.dir,
      'force-app',
      'main',
      'default',
      'permissionsets',
      'ebikes.permissionset-meta.xml'
    );
    const original = await fs.promises.readFile(target, 'utf8');
    await fs.promises.writeFile(target, `${original}\n<!-- modified -->`);

    // add a new file
    await fs.promises.writeFile(
      path.join(session.project.dir, 'force-app', 'main', 'default', 'classes', 'NewClass.cls'),
      'public class NewClass {}'
    );

    // set the env var
    process.env.SF_SOURCE_TRACKING_ASSUME_SYNCED = 'true';

    // force a fresh status check — should still return empty
    const status = await repo.getStatus(true);
    expect(status).to.deep.equal([]);
    expect(await repo.getChangedFilenames()).to.deep.equal([]);
    expect(await repo.getDeletes()).to.deep.equal([]);
    expect(await repo.getNonDeletes()).to.deep.equal([]);
    expect(await repo.getAdds()).to.deep.equal([]);
    expect(await repo.getModifies()).to.deep.equal([]);
  });

  it('commitChanges with explicit files still works when env var is set', async () => {
    const explicitFile = path.normalize('force-app/main/default/classes/NewClass.cls');
    const sha = await repo.commitChanges({
      deployedFiles: [explicitFile],
      message: 'explicit deploy with assume-synced',
    });
    expect(sha).to.be.a('string');
  });

  it('after unsetting env var, getStatus(true) reveals real changes', async () => {
    delete process.env.SF_SOURCE_TRACKING_ASSUME_SYNCED;

    const status = await repo.getStatus(true);
    // the modified permissionset should show up (NewClass was already committed above)
    expect(status.length).to.be.greaterThan(0);
    const filenames = await repo.getChangedFilenames();
    expect(filenames.some((f) => f.includes('ebikes.permissionset-meta.xml'))).to.be.true;
  });
});
