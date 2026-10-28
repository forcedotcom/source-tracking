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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'chai';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { populateFilePaths } from '../../../src/shared/populateFilePaths';

describe('populateFilePaths', () => {
  let projectPath: string;

  before(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'populateFilePaths-'));
    const bundlePath = path.join(projectPath, 'force-app', 'main', 'default', 'lwc', 'remotePath');
    fs.mkdirSync(bundlePath, { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'remotePath.js'), 'export default class RemotePath {}');
    fs.writeFileSync(path.join(bundlePath, 'remotePath.html'), '<template></template>');
    fs.writeFileSync(
      path.join(bundlePath, 'remotePath.js-meta.xml'),
      '<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><isExposed>false</isExposed></LightningComponentBundle>'
    );
  });

  after(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('returns every local bundle path for a matched remote component', () => {
    const [result] = populateFilePaths({
      elements: [{ origin: 'remote', name: 'remotePath', type: 'LightningComponentBundle' }],
      packageDirPaths: [path.join(projectPath, 'force-app')],
      registry: new RegistryAccess(),
    });

    expect(result).to.include({
      origin: 'remote',
      name: 'remotePath',
      type: 'LightningComponentBundle',
      modified: true,
    });
    expect(result.filenames).to.have.members([
      path.join(projectPath, 'force-app', 'main', 'default', 'lwc', 'remotePath', 'remotePath.js-meta.xml'),
      path.join(projectPath, 'force-app', 'main', 'default', 'lwc', 'remotePath', 'remotePath.html'),
      path.join(projectPath, 'force-app', 'main', 'default', 'lwc', 'remotePath', 'remotePath.js'),
    ]);
  });
});
