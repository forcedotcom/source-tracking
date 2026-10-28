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
import * as gracefulFs from 'graceful-fs';
import git from 'isomorphic-git';
import { expect, config } from 'chai';
import sinon from 'sinon';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../src/shared/local/localShadowRepo';
import { filenameMatchesToMap } from '../../src/shared/local/moveDetection';

config.truncateThreshold = 0;

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};
afterEach(() => {
  // Restore the default sandbox here
  sinon.restore();
});

describe('local detect moved files', () => {
  const registry = new RegistryAccess();
  afterEach(() => {
    // Clean up environment variable if it was set
    delete process.env.SF_DISABLE_SOURCE_MOBILITY;
  });

  it('automatically commits moved files', async () => {
    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'new', 'labels'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'force-app', 'labels'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'force-app', 'labels', 'CustomLabels.labels-meta.xml'), '<xml></xml>');
      fs.writeFileSync(path.join(projectDir, 'force-app', 'labels', 'CustomLabelsTwo.labels-meta.xml'), '<xml></xml>');

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
      const labelsFile = path.join('force-app', 'labels', 'CustomLabels.labels-meta.xml');
      const labelsFileTwo = path.join('force-app', 'labels', 'CustomLabelsTwo.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile, labelsFileTwo] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // Move the file and refresh the status
      fs.renameSync(
        path.join(projectDir, labelsFile),
        path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabels.labels-meta.xml')
      );

      fs.renameSync(
        path.join(projectDir, labelsFileTwo),
        path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabelsTwo.labels-meta.xml')
      );
      await shadowRepo.getStatus(true);

      // Moved file should have been detected and committed
      expect(gitAdd.calledTwice).to.be.true;
      expect(await shadowRepo.getChangedRows()).to.be.empty;
    } finally {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('normalizes moves that cross internal candidate and type-resolution boundaries', async () => {
    let projectDir!: string;
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoBatchedMoveTest'));
      const sourceDir = path.join(projectDir, 'force-app', 'labels');
      const destinationDir = path.join(projectDir, 'force-app', 'new', 'labels');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(destinationDir, { recursive: true });
      const files = Array.from({ length: 51 }, (_unused, index) =>
        path.join('force-app', 'labels', `CustomLabels${String(index).padStart(2, '0')}.labels-meta.xml`)
      );
      files.forEach((file) => fs.writeFileSync(path.join(projectDir, file), `<xml>${file}</xml>`));

      const shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012346',
        projectPath: projectDir,
        packageDirs: [
          { name: 'dummy', fullPath: path.join(projectDir, 'force-app'), path: path.join(projectDir, 'force-app') },
        ],
        registry,
      });
      await shadowRepo.commitChanges({ deployedFiles: files });
      files.forEach((file) =>
        fs.renameSync(path.join(projectDir, file), path.join(destinationDir, path.basename(file)))
      );

      await shadowRepo.getStatus(true);
      expect(await shadowRepo.getChangedRows()).to.be.empty;
    } finally {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('limits complete candidate operations to one internal batch before starting the next', async () => {
    const candidates = Array.from({ length: 33 }, (_unused, index) => `Class${String(index).padStart(2, '0')}.cls`);
    const added = new Set(candidates.map((filename) => `force-app/new/${filename}`));
    const deleted = new Set(candidates.map((filename) => `force-app/old/${filename}`));
    const gates = Array.from({ length: 32 }, () => deferred<{ oid: string }>());
    const first31HashesComplete = deferred<void>();
    const addedStarts: string[] = [];
    let activeHashes = 0;
    let completedHashes = 0;
    let highWaterMark = 0;

    sinon.stub(git, 'resolveRef').resolves('head');
    sinon.stub(gracefulFs.promises, 'readFile').callsFake(async (filepath) => {
      const filename = path.basename(typeof filepath === 'string' ? filepath : '');
      addedStarts.push(filename);
      return Buffer.from(filename);
    });
    sinon.stub(git, 'hashBlob').callsFake(async ({ object }) => {
      const filename = object.toString();
      activeHashes += 1;
      highWaterMark = Math.max(highWaterMark, activeHashes);
      const gate = gates[addedStarts.indexOf(filename)];
      const result = gate ? await gate.promise : { oid: filename };
      activeHashes -= 1;
      completedHashes += 1;
      if (completedHashes === 31) first31HashesComplete.resolve();
      return result as unknown as Awaited<ReturnType<typeof git.hashBlob>>;
    });
    sinon
      .stub(git, 'readBlob')
      .callsFake(
        async ({ filepath }) =>
          ({ oid: path.basename(filepath as string) } as unknown as Awaited<ReturnType<typeof git.readBlob>>)
      );

    const matching = filenameMatchesToMap(registry)('/project')('/git')({ added, deleted });
    await Promise.resolve();
    await Promise.resolve();
    expect(highWaterMark).to.equal(32);
    expect(addedStarts).to.have.lengthOf(32);

    gates.slice(0, 31).forEach((gate, index) => gate.resolve({ oid: `Class${String(index).padStart(2, '0')}.cls` }));
    await first31HashesComplete.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(addedStarts).to.have.lengthOf(32);
    gates[31].resolve({ oid: 'Class31.cls' });

    const matches = await matching;
    expect(highWaterMark).to.equal(32);
    expect(addedStarts).to.have.lengthOf(33);
    expect(Array.from(matches.fullMatches.keys())).to.deep.equal(Array.from(added));
  });

  it('stops later candidate batches and normalization when an added file operation fails', async () => {
    let projectDir!: string;
    const expectedError = new Error('expected candidate read failure');
    try {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoBatchedFailureTest'));
      const sourceDir = path.join(projectDir, 'force-app', 'classes');
      const destinationDir = path.join(projectDir, 'force-app', 'new', 'classes');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(destinationDir, { recursive: true });
      const files = Array.from({ length: 65 }, (_unused, index) => {
        const name = `BatchedFailure${String(index).padStart(2, '0')}`;
        return [
          path.join('force-app', 'classes', `${name}.cls`),
          path.join('force-app', 'classes', `${name}.cls-meta.xml`),
        ];
      }).flat();
      files.forEach((file) => fs.writeFileSync(path.join(projectDir, file), '<xml></xml>'));

      const shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D456789012347',
        projectPath: projectDir,
        packageDirs: [
          { name: 'dummy', fullPath: path.join(projectDir, 'force-app'), path: path.join(projectDir, 'force-app') },
        ],
        registry,
      });
      await shadowRepo.commitChanges({ deployedFiles: files });
      files.forEach((file) =>
        fs.renameSync(path.join(projectDir, file), path.join(destinationDir, path.basename(file)))
      );

      const originalReadFile = gracefulFs.promises.readFile.bind(gracefulFs.promises);
      let candidateReadCount = 0;
      sinon.stub(gracefulFs.promises, 'readFile').callsFake(async (filepath, options) => {
        if (typeof filepath === 'string' && filepath.startsWith(destinationDir)) {
          candidateReadCount += 1;
          if (candidateReadCount === 64) throw expectedError;
        }
        return originalReadFile(filepath, options);
      });
      const gitAdd = sinon.spy(git, 'add');
      const gitCommit = sinon.spy(git, 'commit');
      const readBlob = sinon.spy(git, 'readBlob');

      let caughtError: unknown;
      try {
        await shadowRepo.getStatus(true);
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).to.equal(expectedError);
      expect(candidateReadCount).to.equal(64);
      expect(readBlob.called).to.equal(false);
      expect(gitAdd.called).to.equal(false);
      expect(gitCommit.called).to.equal(false);
    } finally {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('skips moved file detection when opt-out is enabled', async () => {
    // Opt out of file move detection
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
      const labelsFile = path.join('force-app', 'labels', 'CustomLabels.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // Move the file and refresh the status
      fs.renameSync(
        path.join(projectDir, labelsFile),
        path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabels.labels-meta.xml')
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
      const singleMatchFile = path.join('force-app', 'labels', 'CustomLabelsSingleMatch.labels-meta.xml');
      const multiMatchFile = path.join('force-app', 'labels', 'CustomLabelsMultiMatch.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [singleMatchFile, multiMatchFile] });
      expect(sha).to.not.be.empty;
      expect(gitAdd.calledOnce).to.be.true;

      // For the multi-match file, copy it to two different directories and then rename it
      // The reason we create 3 new copies is to ensure the added/deletedIgnoredSet is working correctly
      // These will all be ignored in the git commit
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
      // For the single-match file, rename it.
      // This file move will be detected and committed
      fs.renameSync(
        path.join(projectDir, singleMatchFile),
        path.join(projectDir, 'force-app', 'foo', 'labels', 'CustomLabelsSingleMatch.labels-meta.xml')
      );
      // Refresh the status
      await shadowRepo.getStatus(true);

      // The single moved file should have been detected and committed
      expect(gitAdd.calledTwice).to.be.true;
      // However, the ones with multiple matches should have been ignored
      // - Expect getChangedRows to return 4 rows. 1 deleted and 3 added
      expect(await shadowRepo.getChangedRows()).to.have.lengthOf(4);
      expect(warningEmitted).to.include(
        'Files were found that have the same basename, hash, metadata type, and parent. Skipping the commit of these files'
      );
    } finally {
      // Without this, the onWarning() test in metadataKeys.test.ts would fail
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
      const labelsFile = path.join('force-app', 'labels', 'CustomLabels.labels-meta.xml');
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

      // delete is detected and committed, but the add is still considered a change
      expect(gitAdd.calledOnce).to.be.true;
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
      // We will move this file
      const moveFile = path.join('force-app', 'labels', 'CustomLabelsMove.labels-meta.xml');
      fs.writeFileSync(path.join(projectDir, moveFile), '<xml>moved</xml>');
      // We will modify this file
      const modifyFile = path.join('force-app', 'labels', 'CustomLabelsModify.labels-meta.xml');
      fs.writeFileSync(path.join(projectDir, modifyFile), '<xml>modify</xml>');
      // We will delete this file
      const deleteFile = path.join('force-app', 'labels', 'CustomLabelsDelete.labels-meta.xml');
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
        path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabelsMove.labels-meta.xml')
      );
      // Modify this file
      fs.appendFileSync(path.join(projectDir, modifyFile), '<xml>modify</xml>');
      // Delete this file
      fs.unlinkSync(path.join(projectDir, deleteFile));
      // Add a new file post-commit
      const addFile = path.join('force-app', 'labels', 'CustomLabelAdd.labels-meta.xml');
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
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });
});
