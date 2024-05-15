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
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../src/shared/localShadowRepo';

/* eslint-disable no-unused-expressions */

afterEach(() => {
  // Restore the default sandbox here
  sinon.restore();
});

describe('local detect moved files', () => {
  const registry = new RegistryAccess();
  it('automatically commits moved files', async () => {
    expect(process.env.SF_BETA_TRACK_FILE_MOVES).to.be.undefined;
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';

    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'new'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabels.labels-meta.xml'), '<xml></xml>');
      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabelsTwo.labels-meta.xml'), '<xml></xml>');

      const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012345',
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'dummy',
            fullPath: path.join(projectDir, 'force-app'),
            path: path.join(projectDir, 'force-app'),
          },
        ],
        registry,
      });

      const gitAdd = sinon.spy(git, 'add');

      // Manually commit this first file
      const labelsFile = path.join('force-app', 'CustomLabels.labels-meta.xml');
      const labelsFileTwo = path.join('force-app', 'CustomLabelsTwo.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile, labelsFileTwo] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // Move the file and refresh the status
      fs.renameSync(
        path.join(projectDir, labelsFile),
        path.join(projectDir, 'force-app', 'new', 'CustomLabels.labels-meta.xml')
      );

      fs.renameSync(
        path.join(projectDir, labelsFileTwo),
        path.join(projectDir, 'force-app', 'new', 'CustomLabelsTwo.labels-meta.xml')
      );
      await shadowRepo.getStatus(true);

      // Moved file should have been detected and committed
      expect(gitAdd.calledTwice).to.be.true;
      expect(await shadowRepo.getChangedRows()).to.be.empty;
    } finally {
      delete process.env.SF_BETA_TRACK_FILE_MOVES;
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('skips moved file detection if BETA env var is NOT set', async () => {
    expect(process.env.SF_BETA_TRACK_FILE_MOVES).to.be.undefined;
    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'new'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabels.labels-meta.xml'), '<xml></xml>');

      const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012345',
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'dummy',
            fullPath: path.join(projectDir, 'force-app'),
            path: path.join(projectDir, 'force-app'),
          },
        ],
        registry,
      });

      const gitAdd = sinon.spy(git, 'add');

      // Manually commit this first file
      const labelsFile = path.join('force-app', 'CustomLabels.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // Move the file and refresh the status
      fs.renameSync(
        path.join(projectDir, labelsFile),
        path.join(projectDir, 'force-app', 'new', 'CustomLabels.labels-meta.xml')
      );

      await shadowRepo.getStatus(true);

      // Moved file should NOT have been detected and committed
      expect(gitAdd.calledTwice).to.be.false;
      expect(await shadowRepo.getChangedRows()).to.have.lengthOf(2);
    } finally {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('ignores files if basename/hash matches are found', async () => {
    expect(process.env.SF_BETA_TRACK_FILE_MOVES).to.be.undefined;
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';
    let projectDir!: string;

    // Catch the LifecycleWarning
    const { Lifecycle } = await import('@salesforce/core');
    const warningEmitted: string[] = [];
    const lc = Lifecycle.getInstance();
    lc.onWarning(async (warning): Promise<void> => {
      warningEmitted.push(warning);
      return Promise.resolve();
    });

    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'foo'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'force-app', 'bar'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'baz'));

      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabelsSingleMatch.labels-meta.xml'), '<xml></xml>');
      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabelsMultiMatch.labels-meta.xml'), '<xml></xml>');

      const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012345',
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'dummy',
            fullPath: path.join(projectDir, 'force-app'),
            path: path.join(projectDir, 'force-app'),
          },
        ],
        registry,
      });

      const gitAdd = sinon.spy(git, 'add');

      // Manually commit the two files first
      const singleMatchFile = path.join('force-app', 'CustomLabelsSingleMatch.labels-meta.xml');
      const multiMatchFile = path.join('force-app', 'CustomLabelsMultiMatch.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [singleMatchFile, multiMatchFile] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // For the multi-match file, copy it to two different directories and then rename it
      // The reason we create 3 new copies is to ensure the added/deletedIgnoredSet is working correctly
      // These will all be ignored in the git commit
      fs.copyFileSync(
        path.join(projectDir, multiMatchFile),
        path.join(projectDir, 'force-app', 'foo', 'CustomLabelsMultiMatch.labels-meta.xml')
      );
      fs.copyFileSync(
        path.join(projectDir, multiMatchFile),
        path.join(projectDir, 'force-app', 'baz', 'CustomLabelsMultiMatch.labels-meta.xml')
      );
      fs.renameSync(
        path.join(projectDir, multiMatchFile),
        path.join(projectDir, 'force-app', 'bar', 'CustomLabelsMultiMatch.labels-meta.xml')
      );
      // For the single-match file, rename it.
      // This file move will be detected and committed
      fs.renameSync(
        path.join(projectDir, singleMatchFile),
        path.join(projectDir, 'force-app', 'foo', 'CustomLabelsSingleMatch.labels-meta.xml')
      );
      // Refresh the status
      await shadowRepo.getStatus(true);

      // The single moved file should have been detected and committed
      expect(gitAdd.calledTwice).to.be.true;
      // However, the ones with multiple matches should have been ignored
      // - Expect getChangedRows to return 4 rows. 1 deleted and 3 added
      expect(await shadowRepo.getChangedRows()).to.have.lengthOf(4);
      expect(warningEmitted).to.include(
        'Files were found that have the same basename and hash. Skipping the commit of these files'
      );
    } finally {
      delete process.env.SF_BETA_TRACK_FILE_MOVES;
      // Without this, the onWarning() test in metadataKeys.test.ts would fail
      lc.removeAllListeners('warning');
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('ignores moved files if the contents have also changed', async () => {
    expect(process.env.SF_BETA_TRACK_FILE_MOVES).to.be.undefined;
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';
    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'new'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabels.labels-meta.xml'), '<xml></xml>');

      const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012345',
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'dummy',
            fullPath: path.join(projectDir, 'force-app'),
            path: path.join(projectDir, 'force-app'),
          },
        ],
        registry,
      });

      const gitAdd = sinon.spy(git, 'add');

      // Manually commit this first file
      const labelsFile = path.join('force-app', 'CustomLabels.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // Move the file
      fs.renameSync(
        path.join(projectDir, labelsFile),
        path.join(projectDir, 'force-app', 'new', 'CustomLabels.labels-meta.xml')
      );
      // Add some content to the moved file
      fs.appendFileSync(path.join(projectDir, 'force-app', 'new', 'CustomLabels.labels-meta.xml'), '<xml>foo</xml>');
      // Refresh the status
      await shadowRepo.getStatus(true);

      // Moved file should NOT have been detected and committed
      expect(gitAdd.calledOnce).to.be.true;
      expect(await shadowRepo.getDeletes()).to.have.lengthOf(1);
      expect(await shadowRepo.getAdds()).to.have.lengthOf(1);
    } finally {
      delete process.env.SF_BETA_TRACK_FILE_MOVES;
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('automatically commits moved files and leaves other changes alone', async () => {
    expect(process.env.SF_BETA_TRACK_FILE_MOVES).to.be.undefined;
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';
    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'new'), { recursive: true });
      // We will move this file
      const moveFile = path.join('force-app', 'CustomLabelsMove.labels-meta.xml');
      fs.writeFileSync(path.join(projectDir, moveFile), '<xml>moved</xml>');
      // We will modify this file
      const modifyFile = path.join('force-app', 'CustomLabelsModify.labels-meta.xml');
      fs.writeFileSync(path.join(projectDir, modifyFile), '<xml>modify</xml>');
      // We will delete this file
      const deleteFile = path.join('force-app', 'CustomLabelsDelete.labels-meta.xml');
      fs.writeFileSync(path.join(projectDir, deleteFile), '<xml>delete</xml>');

      const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012345',
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'dummy',
            fullPath: path.join(projectDir, 'force-app'),
            path: path.join(projectDir, 'force-app'),
          },
        ],
        registry,
      });

      const gitAdd = sinon.spy(git, 'add');

      // Manually commit the files first
      const sha = await shadowRepo.commitChanges({ deployedFiles: [moveFile, modifyFile, deleteFile] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // Move the file this file
      fs.renameSync(
        path.join(projectDir, moveFile),
        path.join(projectDir, 'force-app', 'new', 'CustomLabelsMove.labels-meta.xml')
      );
      // Modify this file
      fs.appendFileSync(path.join(projectDir, modifyFile), '<xml>modify</xml>');
      // Delete this file
      fs.unlinkSync(path.join(projectDir, deleteFile));
      // Add a new file post-commit
      const addFile = path.join('force-app', 'CustomLabelAdd.labels-meta.xml');
      fs.writeFileSync(path.join(projectDir, addFile), '<xml>add</xml>');

      await shadowRepo.getStatus(true);

      // Moved file should have been detected and committed, leaving the remaining changes
      expect(gitAdd.calledTwice).to.be.true;
      expect(await shadowRepo.getAddFilenames()).to.have.lengthOf(1);
      expect(await shadowRepo.getAddFilenames()).to.have.members([addFile]);
      expect(await shadowRepo.getDeleteFilenames()).to.have.lengthOf(1);
      expect(await shadowRepo.getDeleteFilenames()).to.have.members([deleteFile]);
      expect(await shadowRepo.getModifyFilenames()).to.have.lengthOf(1);
      expect(await shadowRepo.getModifyFilenames()).to.have.members([modifyFile]);
    } finally {
      delete process.env.SF_BETA_TRACK_FILE_MOVES;
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });
});
