/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import path from 'node:path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import * as fs from 'graceful-fs';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';

const registry = new RegistryAccess();

describe('handles non-top-level ignore inside project dir', () => {
  let session: TestSession;
  let repo: ShadowRepo;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'repros', 'nested-classes'),
      },
      devhubAuthStrategy: 'NONE',
    });
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId2',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'classes', name: 'classes', fullPath: path.join(session.project.dir, 'classes') }],
      registry,
    });
    // verify the local tracking files/directories
    expect(fs.existsSync(repo.gitDir));
  });

  it('should not be influenced by gitignore', async () => {
    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.length(2);
  });

  after(async () => {
    await session?.clean();
  });
});

describe('handles non-top-level ignore outside project dir', () => {
  let session: TestSession;
  let repo: ShadowRepo;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'repros', 'nested-classes2'),
      },
      devhubAuthStrategy: 'NONE',
    });
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId2',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'classes', name: 'classes', fullPath: path.join(session.project.dir, 'classes') }],
      registry,
    });
    // verify the local tracking files/directories
    expect(fs.existsSync(repo.gitDir));
  });

  it('should not be influenced by gitignore', async () => {
    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.length(2);
  });

  after(async () => {
    await session?.clean();
  });
});
