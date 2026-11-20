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
import os from 'node:os';
import fs from 'node:fs';
import git from 'isomorphic-git';
import sinon from 'sinon';
import { expect } from 'chai';
import { MockTestOrgData, instantiateContext, stubContext, restoreContext } from '@salesforce/core/testSetup';
import { Org, SfProject } from '@salesforce/core';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { SourceTracking } from '../../src/sourceTracking';

describe('SourceTracking.updateLocalTracking', () => {
  const $$ = instantiateContext();
  const classes = path.join('force-app', 'main', 'default', 'classes');
  const cls = (name: string): string[] => [
    path.join(classes, `${name}.cls`),
    path.join(classes, `${name}.cls-meta.xml`),
  ];
  const meta = '<?xml version="1.0" encoding="UTF-8"?><ApexClass><apiVersion>62.0</apiVersion></ApexClass>';

  let projectDir: string;
  let tracking: SourceTracking;

  const write = (relPath: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(projectDir, relPath)), { recursive: true });
    fs.writeFileSync(path.join(projectDir, relPath), content);
  };
  const writeClass = (name: string): void => {
    write(cls(name)[0], `public class ${name} {}`);
    write(cls(name)[1], meta);
  };

  beforeEach(async () => {
    stubContext($$);
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updateLocalTracking'));
    const orgData = new MockTestOrgData();
    orgData.tracksSource = true;
    await $$.stubAuths(orgData);
    const org = await Org.create({ aliasOrUsername: orgData.username });
    const project = SfProject.getInstance();
    sinon.stub(project, 'getPath').returns(projectDir);
    sinon
      .stub(project, 'getPackageDirectories')
      .returns([{ name: 'force-app', path: 'force-app', fullPath: path.join(projectDir, 'force-app'), default: true }]);

    // baseline: A, B and C are tracked and in sync
    ['A', 'B', 'C'].map((name) => writeClass(name));
    tracking = await SourceTracking.create({ org, project, registry: new RegistryAccess() });
    await tracking.resetLocalTracking();

    // local edits: add D, modify A, delete B, move C into a subfolder
    writeClass('D');
    write(cls('A')[0], 'public class A { Integer i; }');
    cls('B').map((f) => fs.rmSync(path.join(projectDir, f)));
    fs.mkdirSync(path.join(projectDir, classes, 'sub'));
    cls('C').map((f) =>
      fs.renameSync(path.join(projectDir, f), path.join(projectDir, classes, 'sub', path.basename(f)))
    );
    // the deploy command reads the status before it deploys
    await tracking.reReadLocalTrackingCache();
  });

  afterEach(async () => {
    restoreContext($$);
    sinon.restore();
    if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
  });

  // deploy D and the delete of B; A stays modified and not deployed
  const deployDAndDeleteB = (): Promise<void> =>
    tracking.updateLocalTracking({
      files: cls('D').map((f) => path.join(projectDir, f)),
      deletedFiles: cls('B').map((f) => path.join(projectDir, f)),
    });

  it('does not scan the files after its commit', async () => {
    const statusMatrixSpy = sinon.spy(git, 'statusMatrix');
    await deployDAndDeleteB();
    expect(statusMatrixSpy.callCount).to.equal(0);
  });

  it('returns the status after the commit on the next status read', async () => {
    await deployDAndDeleteB();
    // only the undeployed edit of A is left; the add of D, the delete of B and the move of C are committed
    expect(await tracking.getChanges({ origin: 'local', state: 'nondelete', format: 'string' })).to.deep.equal([
      path.join(classes, 'A.cls'),
    ]);
    expect(await tracking.getChanges({ origin: 'local', state: 'delete', format: 'string' })).to.deep.equal([]);
  });
});
