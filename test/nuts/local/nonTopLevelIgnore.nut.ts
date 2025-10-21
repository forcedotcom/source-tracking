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
import * as fs from 'node:fs';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
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
