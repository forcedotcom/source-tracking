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
import os from 'node:os';
import fs from 'node:fs';
import git from 'isomorphic-git';
import { expect } from 'chai';
import sinon from 'sinon';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../src/shared/local/localShadowRepo';

/* eslint-disable no-unused-expressions */

afterEach(() => {
  // Restore the default sandbox here
  sinon.restore();
});

describe('localShadowRepo', () => {
  const registry = new RegistryAccess();
  it('does not add same file multiple times', async () => {
    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app'));
      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabels.labels-meta.xml'), '');

      const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012345',
        registry,
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'dummy',
            fullPath: 'dummy',
            path: path.join(projectDir, 'force-app'),
          },
        ],
      });

      const gitAdd = sinon.spy(git, 'add');

      const labelsFile = path.join('force-app', 'CustomLabels.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile, labelsFile] });

      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;
    } finally {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });
});
