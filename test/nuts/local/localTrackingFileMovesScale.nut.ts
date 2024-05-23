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
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';

/* eslint-disable no-unused-expressions */

const dirCount = 20;
const classesPerDir = 50;
const classCount = dirCount * classesPerDir;

const nonProjDirFiles = 100_000;

describe(`handles local files moves of ${classCount.toLocaleString()} classes (${(
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
    const notProjectDir = path.join(session.project.dir, 'not-project-dir');
    await fs.promises.mkdir(notProjectDir);
    for (let i = 0; i < nonProjDirFiles; i++) {
      fs.writeFileSync(path.join(notProjectDir, `file${i}.txt`), 'hello');
    }
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
      registry: new RegistryAccess(),
    });
  });

  it('should show 0 files in git status after moving them', async () => {
    expect(process.env.SF_BETA_TRACK_FILE_MOVES).to.be.undefined;
    process.env.SF_BETA_TRACK_FILE_MOVES = 'true';
    // Commit the existing class files
    filesToSync = await repo.getChangedFilenames();
    await repo.commitChanges({ deployedFiles: filesToSync });

    // move all the classes to the new folder
    fs.mkdirSync(path.join(session.project.dir, 'force-app', 'main', 'foo'), { recursive: true });
    fs.renameSync(
      path.join(session.project.dir, 'force-app', 'main', 'default', 'classes'),
      path.join(session.project.dir, 'force-app', 'main', 'foo', 'classes')
    );

    await repo.getStatus(true);

    expect(await repo.getChangedFilenames())
      .to.be.an('array')
      .with.lengthOf(0);
    delete process.env.SF_BETA_TRACK_FILE_MOVES;
  });
});
