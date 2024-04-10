/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
// @ts-expect-error isogit has both ESM and CJS exports but node16 module/resolution identifies it as ESM
import git from 'isomorphic-git';
import { expect } from 'chai';
import sinon = require('sinon');
import { ShadowRepo } from '../../src/shared/localShadowRepo';

/* eslint-disable no-unused-expressions */

afterEach(() => {
  // Restore the default sandbox here
  sinon.restore();
});

describe('localShadowRepo', () => {
  it('does not add same file multiple times', async () => {
    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app'));
      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabels.labels-meta.xml'), '');

      const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012345',
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
  it('respects SFDX_SOURCE_TRACKING_BATCH_SIZE env var', async () => {
    expect(process.env.SFDX_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
    process.env.SFDX_SOURCE_TRACKING_BATCH_SIZE = '1';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));

    const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
      orgId: '00D456789012345',
      projectPath: projectDir,
      packageDirs: [
        {
          name: 'dummy',
          fullPath: 'dummy',
          path: path.join(projectDir, 'force-app'),
        },
      ],
    });
    // private property maxFileAdd
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    expect(shadowRepo.maxFileAdd).to.equal(1);
    delete process.env.SFDX_SOURCE_TRACKING_BATCH_SIZE;
    expect(process.env.SFDX_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
  });

  it('respects SF_SOURCE_TRACKING_BATCH_SIZE env var', async () => {
    expect(process.env.SF_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
    process.env.SF_SOURCE_TRACKING_BATCH_SIZE = '1';
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));

    const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
      orgId: '00D456789012345',
      projectPath: projectDir,
      packageDirs: [
        {
          name: 'dummy',
          fullPath: 'dummy',
          path: path.join(projectDir, 'force-app'),
        },
      ],
    });
    // private property maxFileAdd
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    expect(shadowRepo.maxFileAdd).to.equal(1);
    delete process.env.SF_SOURCE_TRACKING_BATCH_SIZE;
    expect(process.env.SF_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
  });

  it('respects undefined SF_SOURCE_TRACKING_BATCH_SIZE env var and uses default', async () => {
    expect(process.env.SF_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
    expect(process.env.SFDX_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));

    const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
      orgId: '00D456789012345',
      projectPath: projectDir,
      packageDirs: [
        {
          name: 'dummy',
          fullPath: 'dummy',
          path: path.join(projectDir, 'force-app'),
        },
      ],
    });
    // private property maxFileAdd
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    expect(shadowRepo.maxFileAdd).to.equal(os.type() === 'Windows_NT' ? 8000 : 15_000);
    expect(process.env.SF_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
    expect(process.env.SFDX_SOURCE_TRACKING_BATCH_SIZE).to.be.undefined;
  });
});
