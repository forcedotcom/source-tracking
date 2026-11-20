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
import { Lifecycle } from '@salesforce/core';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../src/shared/local/localShadowRepo';

/** a promise the test resolves by hand, to hold an async step at a known point */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

afterEach(() => {
  // Restore the default sandbox here
  sinon.restore();
});

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

  describe('symlinked packageDirectory', () => {
    let projectDir: string;

    afterEach(async () => {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    });

    it('detects files inside a symlinked packageDirectory root', async () => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoSymlink'));
      // Create the real directory with a file
      const realDir = path.join(projectDir, 'actual');
      fs.mkdirSync(path.join(realDir, 'main', 'default', 'classes'), { recursive: true });
      fs.writeFileSync(path.join(realDir, 'main', 'default', 'classes', 'Foo.cls'), 'public class Foo {}');

      // Create a symlink that points to the real directory
      const symlinkPath = path.join(projectDir, 'force-app');
      fs.symlinkSync(realDir, symlinkPath, 'dir');

      const shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D000000000003',
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

      const changed = await shadowRepo.getChangedFilenames();
      expect(changed).to.be.an('array').with.length.greaterThan(0);
      expect(changed.some((f) => f.includes('Foo.cls'))).to.be.true;
    });

    it('survives a symlink cycle inside a packageDirectory', async () => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoSymlink'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'main', 'default', 'classes'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'force-app', 'main', 'default', 'classes', 'Real.cls'),
        'public class Real {}'
      );
      // cycle: force-app/cycle -> force-app (points back to itself)
      fs.symlinkSync(path.join(projectDir, 'force-app'), path.join(projectDir, 'force-app', 'cycle'), 'dir');

      const shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D000000000005',
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

      const changed = await shadowRepo.getChangedFilenames();
      expect(changed).to.be.an('array').with.length.greaterThan(0);
      expect(changed.some((f) => f.includes('Real.cls'))).to.be.true;
    });

    it('survives a dangling symlink inside a packageDirectory', async () => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoSymlink'));
      fs.mkdirSync(path.join(projectDir, 'force-app', 'main', 'default', 'classes'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'force-app', 'main', 'default', 'classes', 'Real.cls'),
        'public class Real {}'
      );
      // dangling: force-app/dangling -> non-existent-target
      fs.symlinkSync('non-existent-target', path.join(projectDir, 'force-app', 'dangling'), 'file');

      const shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D000000000006',
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

      const changed = await shadowRepo.getChangedFilenames();
      expect(changed).to.be.an('array').with.length.greaterThan(0);
      expect(changed.some((f) => f.includes('Real.cls'))).to.be.true;
    });

    it('detects files inside a packageDirectory with a symlink in the middle of the path', async () => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoSymlink'));
      // Create the real shared-lib directory
      const sharedLib = path.join(projectDir, 'shared-lib');
      fs.mkdirSync(path.join(sharedLib, 'force-app', 'main', 'default', 'classes'), { recursive: true });
      fs.writeFileSync(
        path.join(sharedLib, 'force-app', 'main', 'default', 'classes', 'Linked.cls'),
        'public class Linked {}'
      );

      // Create a symlink: links/shared-lib -> ../shared-lib
      fs.mkdirSync(path.join(projectDir, 'links'));
      fs.symlinkSync(path.join('..', 'shared-lib'), path.join(projectDir, 'links', 'shared-lib'), 'dir');

      const shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D000000000004',
        registry,
        projectPath: projectDir,
        packageDirs: [
          {
            name: 'links/shared-lib/force-app',
            fullPath: path.join(projectDir, 'links', 'shared-lib', 'force-app'),
            path: 'links/shared-lib/force-app',
          },
        ],
      });

      const changed = await shadowRepo.getChangedFilenames();
      expect(changed).to.be.an('array').with.length.greaterThan(0);
      expect(changed.some((f) => f.includes('Linked.cls'))).to.be.true;
    });
  });

  describe('commitChanges status refresh', () => {
    let projectDir: string;
    let shadowRepo: ShadowRepo;
    const foo = path.join('force-app', 'Foo.cls');
    const bar = path.join('force-app', 'Bar.cls');

    beforeEach(async () => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localShadowRepoCommit'));
      fs.mkdirSync(path.join(projectDir, 'force-app'));
      fs.writeFileSync(path.join(projectDir, foo), 'public class Foo {}');
      fs.writeFileSync(path.join(projectDir, bar), 'public class Bar {}');
      shadowRepo = await ShadowRepo.getInstance({
        orgId: '00D000000000007',
        registry,
        projectPath: projectDir,
        packageDirs: [{ name: 'force-app', fullPath: path.join(projectDir, 'force-app'), path: 'force-app' }],
      });
      // fill the status cache, as a deploy does before it commits
      await shadowRepo.getStatus();
    });

    afterEach(async () => {
      if (projectDir) await fs.promises.rm(projectDir, { recursive: true });
    });

    it('does not scan the files when needsUpdatedStatus is false', async () => {
      const statusMatrixSpy = sinon.spy(git, 'statusMatrix');
      await shadowRepo.commitChanges({ deployedFiles: [foo], needsUpdatedStatus: false });
      expect(statusMatrixSpy.callCount).to.equal(0);
    });

    it('returns the status after the commit on the next getStatus when needsUpdatedStatus is false', async () => {
      await shadowRepo.commitChanges({ deployedFiles: [foo], needsUpdatedStatus: false });
      expect(await shadowRepo.getStatus()).to.deep.equal([
        [bar, 0, 2, 0],
        [foo, 1, 1, 1],
      ]);
    });

    it('shares one scan between parallel status reads after a commit with needsUpdatedStatus false', async () => {
      await shadowRepo.commitChanges({ deployedFiles: [foo], needsUpdatedStatus: false });
      const statusMatrixSpy = sinon.spy(git, 'statusMatrix');
      const [deletes, nonDeletes] = await Promise.all([
        shadowRepo.getDeleteFilenames(),
        shadowRepo.getNonDeleteFilenames(),
      ]);
      expect(statusMatrixSpy.callCount).to.equal(1);
      expect([deletes, nonDeletes]).to.deep.equal([[], [bar]]);
    });

    it('gives the error of a failed shared scan to each reader and scans again on the next read', async () => {
      await shadowRepo.commitChanges({ deployedFiles: [foo], needsUpdatedStatus: false });
      sinon.stub(git, 'statusMatrix').onFirstCall().rejects(new Error('scan failed')).callThrough();
      const results = await Promise.allSettled([shadowRepo.getStatus(), shadowRepo.getStatus()]);
      expect(results.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : r.status))).to.deep.equal([
        'scan failed',
        'scan failed',
      ]);
      expect(await shadowRepo.getStatus()).to.deep.equal([
        [bar, 0, 2, 0],
        [foo, 1, 1, 1],
      ]);
    });

    it('does not cache or share the rows of a scan that a commit overtakes', async () => {
      await shadowRepo.commitChanges({ deployedFiles: [bar], needsUpdatedStatus: false });
      const scanned = gate();
      const release = gate();
      const statusMatrix = git.statusMatrix;
      sinon
        .stub(git, 'statusMatrix')
        .onFirstCall()
        .callsFake(async (args: Parameters<typeof git.statusMatrix>[0]) => {
          const rows = await statusMatrix(args);
          scanned.open();
          await release.promise;
          return rows;
        })
        .callThrough();

      const overtaken = shadowRepo.getStatus();
      await scanned.promise;
      await shadowRepo.commitChanges({ deployedFiles: [foo], needsUpdatedStatus: false });
      const afterCommit = [
        [bar, 1, 1, 1],
        [foo, 1, 1, 1],
      ];
      const readAfterCommit = shadowRepo.getStatus();
      release.open();
      expect(await readAfterCommit).to.deep.equal(afterCommit);
      // the overtaken reader gets the rows of its own scan, from before the commit
      expect(await overtaken).to.deep.equal([
        [bar, 1, 1, 1],
        [foo, 0, 2, 0],
      ]);
      expect(await shadowRepo.getStatus()).to.deep.equal(afterCommit);
    });

    it('returns the scanned rows when a commit clears the status during move detection', async () => {
      await shadowRepo.commitChanges({ deployedFiles: [bar], needsUpdatedStatus: false });
      const inMoveDetection = gate();
      const release = gate();
      sinon
        .stub(Lifecycle.getInstance(), 'emitTelemetry')
        .onFirstCall()
        .callsFake(async () => {
          inMoveDetection.open();
          await release.promise;
        });

      const reading = shadowRepo.getDeleteFilenames();
      await inMoveDetection.promise;
      await shadowRepo.commitChanges({ deployedFiles: [foo], needsUpdatedStatus: false });
      release.open();
      // a scan that waits on itself never settles
      const hung = new Promise((resolve) => setTimeout(() => resolve('scan did not finish'), 2000));
      expect(await Promise.race([reading, hung])).to.deep.equal([]);
    });

    it('scans the files once after the commit by default', async () => {
      const statusMatrixSpy = sinon.spy(git, 'statusMatrix');
      await shadowRepo.commitChanges({ deployedFiles: [foo] });
      expect(statusMatrixSpy.callCount).to.equal(1);
      expect(await shadowRepo.getStatus()).to.deep.equal([
        [bar, 0, 2, 0],
        [foo, 1, 1, 1],
      ]);
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
