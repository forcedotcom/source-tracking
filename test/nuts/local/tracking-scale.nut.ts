/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'node:path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import * as fs from 'graceful-fs';
import { ShadowRepo } from '../../../src/shared/localShadowRepo';

const dirCount = 200;
const classesPerDir = 500;
const classCount = dirCount * classesPerDir;

describe(`verify tracking handles an add of ${classCount.toLocaleString()} classes (${(
  classCount * 2
).toLocaleString()} files across ${dirCount.toLocaleString()} folders)`, () => {
  let session: TestSession;
  let repo: ShadowRepo;
  let filesToSync: string[];

  before(async () => {
    session = await TestSession.create({
      project: {
        name: 'large-repo',
      },
      devhubAuthStrategy: 'NONE',
    });
    // create some number of files
    const classdir = path.join(session.project.dir, 'force-app', 'main', 'default', 'classes');
    for (let d = 0; d < dirCount; d++) {
      const dirName = path.join(classdir, `dir${d}`);
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.mkdir(dirName);
      for (let c = 0; c < classesPerDir; c++) {
        const className = `x${d}x${c}`;
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([
          fs.promises.writeFile(
            path.join(dirName, `${className}.cls`),
            `public with sharing class ${className} {public ${className}() {}}`
          ),
          fs.promises.writeFile(
            path.join(dirName, `${className}.cls-meta.xml`),
            '<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>54.0</apiVersion><status>Active</status></ApexClass>'
          ),
        ]);
      }
    }
  });

  after(async () => {
    await session?.clean();
  });

  it('initialize the local tracking', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
    });
  });

  it(`should see ${(classCount * 2).toLocaleString()} files (git status)`, async () => {
    filesToSync = await repo.getChangedFilenames();
    expect(filesToSync)
      .to.be.an('array')
      // windows ends up with 2 extra files!?
      .with.length.greaterThanOrEqual(classCount * 2);
  });

  it('should sync (commit) them locally without error', async () => {
    await repo.commitChanges({ deployedFiles: filesToSync, needsUpdatedStatus: false });
  });
});
