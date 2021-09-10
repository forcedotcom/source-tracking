/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import * as path from 'path';
import * as fs from 'fs';
import { expect } from 'chai';
import * as shell from 'shelljs';

import { TestSession, execCmd } from '@salesforce/cli-plugins-testkit';
import { Connection, AuthInfo } from '@salesforce/core';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { PushPullResponse } from '../../../src/shared/types';
import { StatusResult } from '../../../src/commands/force/source/status';

let session: TestSession;
const classdir = 'force-app/main/default/classes';
let originalForceIgnore: string;
let conn: Connection;

describe('forceignore changes', () => {
  before(async () => {
    session = await TestSession.create({
      project: {
        name: 'IgnoreProject',
      },
      setupCommands: [
        `sfdx force:org:create -d 1 -s -f ${path.join('config', 'project-scratch-def.json')}`,
        `sfdx force:apex:class:create -n IgnoreTest --outputdir ${classdir}`,
      ],
    });
    originalForceIgnore = await fs.promises.readFile(path.join(session.project.dir, '.forceignore'), 'utf8');
    conn = await Connection.create({
      authInfo: await AuthInfo.create({
        username: (session.setup[0] as { result: { username: string } }).result?.username,
      }),
    });
  });

  after(async () => {
    await session?.zip(undefined, 'artifacts');
    await session?.clean();
  });

  describe('local', () => {
    it('will not push a file that was created, then ignored', async () => {
      // setup a forceIgnore with some file
      const newForceIgnore = originalForceIgnore + '\n' + `${classdir}/IgnoreTest.cls`;
      await fs.promises.writeFile(path.join(session.project.dir, '.forceignore'), newForceIgnore);
      // nothing should push
      const output = execCmd<PushPullResponse[]>('force:source:push --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(output).to.deep.equal([]);
    });

    it('will ignore a class in the ignore file before it was created', async () => {
      // setup a forceIgnore with some file
      const newForceIgnore =
        originalForceIgnore + '\n' + `${classdir}/UnIgnoreTest.cls` + '\n' + `${classdir}/IgnoreTest.cls`;
      await fs.promises.writeFile(path.join(session.project.dir, '.forceignore'), newForceIgnore);

      // add a file in the local source
      shell.exec(`sfdx force:apex:class:create -n UnIgnoreTest --outputdir ${classdir}`, {
        cwd: session.project.dir,
        silent: true,
      });
      // pushes with no results
      const ignoredOutput = execCmd<PushPullResponse[]>('force:source:push --json', { ensureExitCode: 0 }).jsonOutput
        .result;
      // nothing should have been pushed
      expect(ignoredOutput).to.deep.equal([]);
    });

    it('will push files that are now un-ignored', async () => {
      // un-ignore the file
      await fs.promises.writeFile(path.join(session.project.dir, '.forceignore'), originalForceIgnore);

      // verify file pushed in results
      const unIgnoredOutput = execCmd<PushPullResponse[]>('force:source:push --json', { ensureExitCode: 0 }).jsonOutput
        .result;

      // all 4 files should have been pushed
      expect(unIgnoredOutput).to.have.length(4);
      unIgnoredOutput.map((result) => {
        expect(result.type === 'ApexClass');
        expect(result.state === ComponentStatus.Created);
      });
    });
  });

  describe('remote', () => {
    it('adds on the server', async () => {
      const createResult = await conn.tooling.create('ApexClass', {
        Name: 'CreatedClass',
        Body: 'public class CreatedClass {}',
        Status: 'Active',
      });
      if (!Array.isArray(createResult) && createResult.success) {
        expect(createResult.id).to.be.a('string');
      }
    });

    it('will not pull a remote file added to the ignore AFTER it is being tracked', async () => {
      // add that type to the forceignore
      await fs.promises.writeFile(
        path.join(session.project.dir, '.forceignore'),
        originalForceIgnore + '\n' + classdir
      );

      // gets file into source tracking
      const statusOutput = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 })
        .jsonOutput.result;
      expect(statusOutput.some((result) => result.fullName === 'CreatedClass')).to.equal(true);

      // pull doesn't retrieve that change
      const pullOutput = execCmd<PushPullResponse[]>('force:source:pull --json', { ensureExitCode: 0 }).jsonOutput
        .result;
      expect(pullOutput.some((result) => result.fullName === 'CreatedClass')).to.equal(false);
    });
  });
});
