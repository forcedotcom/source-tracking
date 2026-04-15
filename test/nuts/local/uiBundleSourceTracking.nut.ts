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
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { ComponentStatus, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';
import { calculateExpectedSourceMembers } from '../../../src/shared/remote/expectedSourceMembers';

describe('UIBundle excluded from source tracking polling', () => {
  let session: TestSession;
  let projectPath: string;
  const registry = new RegistryAccess();
  const pkgDir = 'force-app';

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'repros', 'reactinternalapp'),
      },
      devhubAuthStrategy: 'NONE',
    });
    projectPath = session.project.dir;
  });

  after(async () => {
    await session?.clean();
  });

  it('local tracking resolves UIBundle files', async () => {
    const repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId-uibundle-tracking',
      projectPath,
      packageDirs: [{ path: pkgDir, name: pkgDir, fullPath: path.join(projectPath, pkgDir) }],
      registry,
    });

    const nonDeletes = await repo.getNonDeleteFilenames();
    const uiBundleFiles = nonDeletes.filter((f) => f.includes('uiBundles'));
    expect(uiBundleFiles.length).to.be.greaterThan(0);
  });

  it('UIBundle deploy responses produce no expected SourceMembers', () => {
    const uiBundleResponses = [
      {
        type: 'UIBundle',
        fullName: 'localReact3',
        filePath: path.join(
          projectPath,
          pkgDir,
          'main',
          'default',
          'uiBundles',
          'localReact3',
          'localReact3.uibundle-meta.xml'
        ),
        state: ComponentStatus.Created,
      },
      {
        type: 'UIBundle',
        fullName: 'localReact3',
        filePath: path.join(projectPath, pkgDir, 'main', 'default', 'uiBundles', 'localReact3', 'src', 'app.tsx'),
        state: ComponentStatus.Created,
      },
      {
        type: 'UIBundle',
        fullName: 'localReact3',
        filePath: path.join(projectPath, pkgDir, 'main', 'default', 'uiBundles', 'localReact3', 'package.json'),
        state: ComponentStatus.Changed,
      },
    ];

    const result = calculateExpectedSourceMembers(registry, uiBundleResponses);
    expect(result.size).to.equal(0);
  });

  it('UIBundle exclusion does not affect other types in mixed deploys', () => {
    const mixedResponses = [
      {
        type: 'UIBundle',
        fullName: 'localReact3',
        filePath: path.join(
          projectPath,
          pkgDir,
          'main',
          'default',
          'uiBundles',
          'localReact3',
          'localReact3.uibundle-meta.xml'
        ),
        state: ComponentStatus.Created,
      },
      {
        type: 'ApexClass',
        fullName: 'TestController',
        filePath: path.join(projectPath, pkgDir, 'main', 'default', 'classes', 'TestController.cls'),
        state: ComponentStatus.Created,
      },
    ];

    const result = calculateExpectedSourceMembers(registry, mixedResponses);
    expect(result.size).to.equal(1);
    expect(result.has('ApexClass###TestController')).to.equal(true);
  });
});
