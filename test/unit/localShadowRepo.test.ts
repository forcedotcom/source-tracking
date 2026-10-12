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
import { expect } from 'chai';
import sinon from 'sinon';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../src/shared/local/localShadowRepo';

afterEach(() => {
  // Restore the default sandbox here
  sinon.restore();
});

/** Helper: create a temp project dir with a ShadowRepo instance */
const setupShadowRepo = async (orgId = '00D456789012345'): Promise<{ projectDir: string; shadowRepo: ShadowRepo }> => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
  fs.mkdirSync(path.join(projectDir, 'force-app'));
  fs.writeFileSync(path.join(projectDir, 'force-app', 'CustomLabels.labels-meta.xml'), '');

  const shadowRepo = await ShadowRepo.getInstance({
    orgId,
    registry: new RegistryAccess(),
    projectPath: projectDir,
    packageDirs: [
      {
        name: 'dummy',
        fullPath: path.join(projectDir, 'force-app'),
        path: path.join(projectDir, 'force-app'),
      },
    ],
  });

  return { projectDir, shadowRepo };
};

describe('localShadowRepo', () => {
  const registry = new RegistryAccess();

  describe('SF_SOURCE_TRACKING_ASSUME_SYNCED', () => {
    let projectDir: string;
    let shadowRepo: ShadowRepo;

    beforeEach(async () => {
      process.env.SF_SOURCE_TRACKING_ASSUME_SYNCED = 'true';
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoTest'));
      fs.mkdirSync(path.join(projectDir, 'force-app'));
      fs.writeFileSync(path.join(projectDir, 'force-app', 'Foo.cls'), 'public class Foo {}');

      shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D000000000002',
        registry,
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'force-app',
            fullPath: path.join(projectDir, 'force-app'),
            path: 'force-app',
          },
        ],
      });
    });

    afterEach(async () => {
      delete process.env.SF_SOURCE_TRACKING_ASSUME_SYNCED;
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    });

    it('returns empty status without calling statusMatrix when set', async () => {
      const statusMatrixSpy = sinon.spy(git, 'statusMatrix');
      const status = await shadowRepo.getStatus(true);

      expect(status).to.deep.equal([]);
      expect(statusMatrixSpy.called).to.be.false;
    });

    it('returns cached empty status on subsequent calls with noCache=true', async () => {
      const statusMatrixSpy = sinon.spy(git, 'statusMatrix');

      const first = await shadowRepo.getStatus(true);
      const second = await shadowRepo.getStatus(true);
      const third = await shadowRepo.getStatus(false);

      expect(first).to.deep.equal([]);
      expect(second).to.deep.equal([]);
      expect(third).to.deep.equal([]);
      expect(statusMatrixSpy.called).to.be.false;
    });

    it('downstream methods return empty results', async () => {
      expect(await shadowRepo.getChangedRows()).to.deep.equal([]);
      expect(await shadowRepo.getChangedFilenames()).to.deep.equal([]);
      expect(await shadowRepo.getDeletes()).to.deep.equal([]);
      expect(await shadowRepo.getDeleteFilenames()).to.deep.equal([]);
      expect(await shadowRepo.getNonDeletes()).to.deep.equal([]);
      expect(await shadowRepo.getNonDeleteFilenames()).to.deep.equal([]);
      expect(await shadowRepo.getAdds()).to.deep.equal([]);
      expect(await shadowRepo.getAddFilenames()).to.deep.equal([]);
      expect(await shadowRepo.getModifies()).to.deep.equal([]);
      expect(await shadowRepo.getModifyFilenames()).to.deep.equal([]);
    });

    it('commitChanges succeeds with no files when env var is set', async () => {
      const result = await shadowRepo.commitChanges({ deployedFiles: [], deletedFiles: [] });
      expect(result).to.equal('no files to commit');
    });

    it('resumes real scanning after env var is unset and noCache=true', async () => {
      // first call with env var set — returns empty
      const emptyStatus = await shadowRepo.getStatus(true);
      expect(emptyStatus).to.deep.equal([]);

      // unset the env var
      delete process.env.SF_SOURCE_TRACKING_ASSUME_SYNCED;

      // without noCache, returns the cached empty array
      const stillCached = await shadowRepo.getStatus(false);
      expect(stillCached).to.deep.equal([]);

      // with noCache=true, should actually scan and find the uncommitted file
      const realStatus = await shadowRepo.getStatus(true);
      expect(realStatus.length).to.be.greaterThan(0);
    });
  });

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

      const writeBlob = sinon.spy(git, 'writeBlob');

      const labelsFile = path.join('force-app', 'CustomLabels.labels-meta.xml');
      const sha = await shadowRepo.commitChanges({ deployedFiles: [labelsFile, labelsFile] });

      expect(sha).to.not.be.empty;
      // Deduplication via Set means only one blob write despite duplicate input
      expect(writeBlob.calledOnce).to.be.true;
    } finally {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    }
  });
});

describe('git index locking', () => {
  it('holds lock during commitChanges', async () => {
    const { projectDir, shadowRepo } = await setupShadowRepo('00Dlock_commit');

    try {
      let lockExistedDuringAdd = false;
      const lockDir = path.join(shadowRepo.gitDir, 'index.lock');

      const origWriteBlob = git.writeBlob.bind(git);
      sinon.stub(git, 'writeBlob').callsFake(async (args) => {
        lockExistedDuringAdd = fs.existsSync(lockDir);
        return origWriteBlob(args);
      });

      const labelsFile = path.join('force-app', 'CustomLabels.labels-meta.xml');
      await shadowRepo.commitChanges({ deployedFiles: [labelsFile] });

      expect(lockExistedDuringAdd).to.be.true;
      // lock should be released after the operation
      expect(fs.existsSync(lockDir)).to.be.false;
    } finally {
      await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('holds lock during getStatus', async () => {
    const { projectDir, shadowRepo } = await setupShadowRepo('00Dlock_status');

    try {
      let lockExistedDuringStatus = false;
      const lockDir = path.join(shadowRepo.gitDir, 'index.lock');

      const origStatusMatrix = git.statusMatrix.bind(git);
      sinon.stub(git, 'statusMatrix').callsFake(async (args) => {
        lockExistedDuringStatus = fs.existsSync(lockDir);
        return origStatusMatrix(args);
      });

      await shadowRepo.getStatus(true);

      expect(lockExistedDuringStatus).to.be.true;
      expect(fs.existsSync(lockDir)).to.be.false;
    } finally {
      await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('skips locking for empty commitChanges (no files)', async () => {
    const { projectDir, shadowRepo } = await setupShadowRepo('00Dlock_empty');

    try {
      const result = await shadowRepo.commitChanges({ deployedFiles: [], deletedFiles: [] });

      expect(result).to.equal('no files to commit');
    } finally {
      await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('skips locking for cached getStatus', async () => {
    const { projectDir, shadowRepo } = await setupShadowRepo('00Dlock_cache');

    try {
      // First call populates cache
      await shadowRepo.getStatus();

      let lockAcquiredOnSecondCall = false;
      const lockDir = path.join(shadowRepo.gitDir, 'index.lock');

      const origStatusMatrix = git.statusMatrix.bind(git);
      sinon.stub(git, 'statusMatrix').callsFake(async (args) => {
        lockAcquiredOnSecondCall = fs.existsSync(lockDir);
        return origStatusMatrix(args);
      });

      // Second call (cached) should not re-acquire lock or call statusMatrix
      await shadowRepo.getStatus();
      expect(lockAcquiredOnSecondCall).to.be.false;
    } finally {
      await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('does not deadlock on reentrant getStatus -> commitChanges chain', async () => {
    // This tests the reentrancy path: getStatus() -> detectMovedFiles() -> commitChanges()
    // If locking were not reentrant, this would deadlock.
    const { projectDir, shadowRepo } = await setupShadowRepo('00Dlock_reentrant');

    try {
      fs.mkdirSync(path.join(projectDir, 'force-app', 'new', 'labels'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'force-app', 'labels'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'force-app', 'labels', 'CustomLabels.labels-meta.xml'), '<xml></xml>');

      // Commit the file so it's tracked
      const labelsFile = path.join('force-app', 'labels', 'CustomLabels.labels-meta.xml');
      await shadowRepo.commitChanges({ deployedFiles: [labelsFile] });

      // Move the file, which triggers detectMovedFiles -> commitChanges inside getStatus
      fs.renameSync(
        path.join(projectDir, labelsFile),
        path.join(projectDir, 'force-app', 'new', 'labels', 'CustomLabels.labels-meta.xml')
      );

      // This must complete without deadlocking
      const status = await shadowRepo.getStatus(true);
      expect(status).to.be.an('array');
    } finally {
      await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('releases lock when operation throws', async () => {
    const { projectDir, shadowRepo } = await setupShadowRepo('00Dlock_throw');

    try {
      const lockDir = path.join(shadowRepo.gitDir, 'index.lock');

      // Commit a non-existent file to trigger an error inside the lock
      try {
        await shadowRepo.commitChanges({ deployedFiles: ['force-app/does-not-exist.cls'] });
      } catch {
        // expected
      }

      // Lock should have been released
      expect(fs.existsSync(lockDir)).to.be.false;

      // A second operation should succeed (not blocked by a stale lock)
      const status = await shadowRepo.getStatus(true);
      expect(status).to.be.an('array');
    } finally {
      await fs.promises.rm(projectDir, { recursive: true });
    }
  });

  it('delete removes gitDir and survives lock cleanup', async () => {
    const { projectDir, shadowRepo } = await setupShadowRepo('00Dlock_delete');

    try {
      const deletedDir = await shadowRepo.delete();

      expect(deletedDir).to.equal(shadowRepo.gitDir);
      expect(fs.existsSync(shadowRepo.gitDir)).to.be.false;
    } finally {
      await fs.promises.rm(projectDir, { recursive: true, force: true });
    }
  });
});
