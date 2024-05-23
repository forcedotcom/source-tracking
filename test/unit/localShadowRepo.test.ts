/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import path from 'node:path';
import * as os from 'node:os';
import fs from 'node:fs';
// @ts-expect-error isogit has both ESM and CJS exports but node16 module/resolution identifies it as ESM
import git from 'isomorphic-git';
import { expect } from 'chai';
import sinon = require('sinon');
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
