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
import { execSync } from 'node:child_process';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';
import { getGroupedFiles, getComponentSets } from '../../../src/shared/localComponentSetArray';

const findUiBundleDir = (projectDir: string): string => {
  const uiBundlesRoot = path.join(projectDir, 'force-app', 'main', 'default', 'uiBundles');
  const entries = fs.readdirSync(uiBundlesRoot, { withFileTypes: true });
  const first = entries.find((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (!first) throw new Error(`No uiBundle directory found under ${uiBundlesRoot}`);
  return path.join(uiBundlesRoot, first.name);
};

describe('reactinternalapp template: getComponentSets dedup check', () => {
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
    execSync('npm install --registry https://registry.npmjs.org/', {
      cwd: findUiBundleDir(projectPath),
      stdio: 'inherit',
    });
  });

  after(async () => {
    await session?.clean();
  });

  it('single pkgDir: no duplicate filenames in groupings', async () => {
    const repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId-reactapp-single',
      projectPath,
      packageDirs: [{ path: pkgDir, name: pkgDir, fullPath: path.join(projectPath, pkgDir) }],
      registry,
    });

    const [nonDeletes, deletes] = await Promise.all([repo.getNonDeleteFilenames(), repo.getDeleteFilenames()]);

    // All files are new (not committed), so deletes should be empty
    expect(deletes).to.have.lengthOf(0);
    expect(nonDeletes.length).to.be.greaterThan(0);

    const groupings = getGroupedFiles(
      {
        packageDirs: [{ path: pkgDir, name: pkgDir, fullPath: path.join(projectPath, pkgDir) }],
        nonDeletes,
        deletes,
      },
      false
    );

    expect(groupings).to.have.lengthOf(1);
    // No duplicates: grouping should have exactly the same count as the raw filenames
    expect(groupings[0].nonDeletes.length).to.equal(nonDeletes.length);

    // Calling getComponentSets triggers the instrumented lines
    getComponentSets({ groupings, registry, projectPath });
  });
});
