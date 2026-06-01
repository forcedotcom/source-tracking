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
import { expect, config } from 'chai';
import sinon from 'sinon';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../src/shared/local/localShadowRepo';

/* eslint-disable no-unused-expressions */
config.truncateThreshold = 0;
afterEach(() => {
  sinon.restore();
});

/**
 * Move-detection contract: identical assertions exercised against both
 * the isomorphic-git and the lite backend. Each backend gets its own
 * `describe` block so the test names report which path was exercised, and
 * the backend choice is reset between blocks via the env var + cache
 * reset hook.
 */
([true, false] as const).forEach((useLite) => {
  describe(`local detect moved files (${useLite ? 'lite' : 'iso'})`, () => {
    const registry = new RegistryAccess();

    before(() => {
      if (useLite) process.env.SF_SOURCE_TRACKING_USE_LITE_GIT = 'true';
      else delete process.env.SF_SOURCE_TRACKING_USE_LITE_GIT;
      ShadowRepo.resetBackendChoiceForTests();
    });
    after(() => {
      delete process.env.SF_SOURCE_TRACKING_USE_LITE_GIT;
      ShadowRepo.resetBackendChoiceForTests();
    });
    afterEach(() => {
      delete process.env.SF_DISABLE_SOURCE_MOBILITY;
    });

    it('automatically commits moved files', async () => {
      let projectDir!: string;
      try {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
        fs.mkdirSync(path.join(projectDir, 'force-app', 'new', 'labels'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'force-app', 'labels'), { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'force-app', 'labels', 'CustomLabels.labels-meta.xml'), '<xml></xml>');
        fs.writeFileSync(
          path.join(projectDir, 'force-app', 'labels', 'CustomLabelsTwo.labels-meta.xml'),
          '<xml></xml>'
        );

        const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
          orgId: '00D456789012345',
          projectPath: projectDir,
          packageDirs: [
            { name: 'dummy', fullPath: path.join(projectDir, 'force-app'), path: path.join(projectDir, 'force-app') },
          ],
          registry,
        });

        const labelsFile = path.join('force-app', 'labels', 'CustomLabels.labels-meta.xml');
        const labelsFileTwo = path.join('force-app', 'labels', 'CustomLabelsTwo.labels-meta.xml');
        const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile, labelsFileTwo] });
        expect(sha).to.not.be.empty;

        fs.renameSync(
          path.join(projectDir, labelsFile),
          path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabels.labels-meta.xml')
        );
        fs.renameSync(
          path.join(projectDir, labelsFileTwo),
          path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabelsTwo.labels-meta.xml')
        );
        await shadowRepo.getStatus(true);

        // Moved file should have been detected and committed: zero outstanding changes.
        expect(await shadowRepo.getChangedRows()).to.be.empty;
      } finally {
        if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
      }
    });

    it('skips moved file detection when opt-out is enabled', async () => {
      process.env.SF_DISABLE_SOURCE_MOBILITY = 'true';
      let projectDir!: string;
      try {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
        fs.mkdirSync(path.join(projectDir, 'force-app', 'new', 'labels'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'force-app', 'labels'), { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'force-app', 'labels', 'CustomLabels.labels-meta.xml'), '<xml></xml>');

        const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
          orgId: '00D456789012345',
          projectPath: projectDir,
          packageDirs: [
            { name: 'dummy', fullPath: path.join(projectDir, 'force-app'), path: path.join(projectDir, 'force-app') },
          ],
          registry,
        });

        const labelsFile = path.join('force-app', 'labels', 'CustomLabels.labels-meta.xml');
        const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile] });
        expect(sha).to.not.be.empty;

        fs.renameSync(
          path.join(projectDir, labelsFile),
          path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabels.labels-meta.xml')
        );
        await shadowRepo.getStatus(true);

        // Moved file should NOT have been detected: 2 outstanding rows (1 add, 1 delete).
        expect(await shadowRepo.getChangedRows()).to.have.lengthOf(2);
      } finally {
        if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
      }
    });

    it('ignores files if basename/hash matches are found', async () => {
      let projectDir!: string;
      const { Lifecycle } = await import('@salesforce/core');
      const warningEmitted: string[] = [];
      const lc = Lifecycle.getInstance();
      lc.onWarning(async (warning): Promise<void> => {
        warningEmitted.push(warning);
        return Promise.resolve();
      });

      try {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
        fs.mkdirSync(path.join(projectDir, 'force-app', 'labels'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'force-app', 'foo', 'labels'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'force-app', 'bar', 'labels'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'force-app', 'baz', 'labels'), { recursive: true });

        fs.writeFileSync(
          path.join(projectDir, 'force-app', 'labels', 'CustomLabelsSingleMatch.labels-meta.xml'),
          '<xml></xml>'
        );
        fs.writeFileSync(
          path.join(projectDir, 'force-app', 'labels', 'CustomLabelsMultiMatch.labels-meta.xml'),
          '<xml></xml>'
        );

        const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
          orgId: '00D456789012345',
          projectPath: projectDir,
          packageDirs: [
            { name: 'dummy', fullPath: path.join(projectDir, 'force-app'), path: path.join(projectDir, 'force-app') },
          ],
          registry,
        });

        const singleMatchFile = path.join('force-app', 'labels', 'CustomLabelsSingleMatch.labels-meta.xml');
        const multiMatchFile = path.join('force-app', 'labels', 'CustomLabelsMultiMatch.labels-meta.xml');
        const sha = await shadowRepo.commitChanges({ deployedFiles: [singleMatchFile, multiMatchFile] });
        expect(sha).to.not.be.empty;

        // Three copies of multi-match → ambiguous. None should auto-commit.
        fs.copyFileSync(
          path.join(projectDir, multiMatchFile),
          path.join(projectDir, 'force-app', 'foo', 'labels', 'CustomLabelsMultiMatch.labels-meta.xml')
        );
        fs.copyFileSync(
          path.join(projectDir, multiMatchFile),
          path.join(projectDir, 'force-app', 'baz', 'labels', 'CustomLabelsMultiMatch.labels-meta.xml')
        );
        fs.renameSync(
          path.join(projectDir, multiMatchFile),
          path.join(projectDir, 'force-app', 'bar', 'labels', 'CustomLabelsMultiMatch.labels-meta.xml')
        );
        // Single-match → should auto-commit.
        fs.renameSync(
          path.join(projectDir, singleMatchFile),
          path.join(projectDir, 'force-app', 'foo', 'labels', 'CustomLabelsSingleMatch.labels-meta.xml')
        );
        await shadowRepo.getStatus(true);

        // 4 outstanding rows: 1 deleted multi-match (renamed) + 3 added multi-match copies.
        // The single-match move was auto-committed, so it doesn't show.
        expect(await shadowRepo.getChangedRows()).to.have.lengthOf(4);
        expect(warningEmitted).to.include(
          'Files were found that have the same basename, hash, metadata type, and parent. Skipping the commit of these files'
        );
      } finally {
        lc.removeAllListeners('warning');
        if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
      }
    });

    it('ignores moved files (add) if the contents have also changed, but notices deletes match', async () => {
      let projectDir!: string;
      try {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
        fs.mkdirSync(path.join(projectDir, 'force-app', 'new', 'labels'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'force-app', 'labels'), { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'force-app', 'labels', 'CustomLabels.labels-meta.xml'), '<xml></xml>');

        const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
          orgId: '00D456789012345',
          projectPath: projectDir,
          packageDirs: [
            { name: 'dummy', fullPath: path.join(projectDir, 'force-app'), path: path.join(projectDir, 'force-app') },
          ],
          registry,
        });

        const labelsFile = path.join('force-app', 'labels', 'CustomLabels.labels-meta.xml');
        const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile] });
        expect(sha).to.not.be.empty;

        fs.renameSync(
          path.join(projectDir, labelsFile),
          path.join(projectDir, 'force-app', 'new', 'CustomLabels.labels-meta.xml')
        );
        fs.appendFileSync(path.join(projectDir, 'force-app', 'new', 'CustomLabels.labels-meta.xml'), '<xml>foo</xml>');
        await shadowRepo.getStatus(true);

        // Delete is detected and committed; the modified add survives.
        expect(await shadowRepo.getDeletes()).to.have.lengthOf(0);
        expect(await shadowRepo.getAdds()).to.have.lengthOf(1);
      } finally {
        if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
      }
    });

    it('automatically commits moved files and leaves other changes alone', async () => {
      let projectDir!: string;
      try {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
        fs.mkdirSync(path.join(projectDir, 'force-app', 'labels'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'force-app', 'new', 'labels'), { recursive: true });
        const moveFile = path.join('force-app', 'labels', 'CustomLabelsMove.labels-meta.xml');
        fs.writeFileSync(path.join(projectDir, moveFile), '<xml>moved</xml>');
        const modifyFile = path.join('force-app', 'labels', 'CustomLabelsModify.labels-meta.xml');
        fs.writeFileSync(path.join(projectDir, modifyFile), '<xml>modify</xml>');
        const deleteFile = path.join('force-app', 'labels', 'CustomLabelsDelete.labels-meta.xml');
        fs.writeFileSync(path.join(projectDir, deleteFile), '<xml>delete</xml>');

        const shadowRepo: ShadowRepo = await ShadowRepo.getInstance({
          orgId: '00D456789012345',
          projectPath: projectDir,
          packageDirs: [
            { name: 'dummy', fullPath: path.join(projectDir, 'force-app'), path: path.join(projectDir, 'force-app') },
          ],
          registry,
        });

        const sha = await shadowRepo.commitChanges({ deployedFiles: [moveFile, modifyFile, deleteFile] });
        expect(sha).to.not.be.empty;

        fs.renameSync(
          path.join(projectDir, moveFile),
          path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabelsMove.labels-meta.xml')
        );
        fs.appendFileSync(path.join(projectDir, modifyFile), '<xml>modify</xml>');
        fs.unlinkSync(path.join(projectDir, deleteFile));
        const addFile = path.join('force-app', 'labels', 'CustomLabelAdd.labels-meta.xml');
        fs.writeFileSync(path.join(projectDir, addFile), '<xml>add</xml>');

        await shadowRepo.getStatus(true);

        // Moved file auto-committed; the unrelated add/delete/modify remain.
        expect(await shadowRepo.getAddFilenames()).to.have.members([addFile]);
        expect(await shadowRepo.getDeleteFilenames()).to.have.members([deleteFile]);
        expect(await shadowRepo.getModifyFilenames()).to.have.members([modifyFile]);
      } finally {
        if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
      }
    });
  });
});
