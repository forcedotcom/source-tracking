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

import { TestSession, execCmd } from '@salesforce/cli-plugins-testkit';
import { Connection, AuthInfo } from '@salesforce/core';
import { expect } from 'chai';
import { StatusResult } from '../../../src/commands/force/source/status';

let session: TestSession;

describe('conflict detection and resolution', () => {
  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
      },
      setupCommands: [`sfdx force:org:create -d 1 -s -f ${path.join('config', 'project-scratch-def.json')}`],
    });
  });

  after(async () => {
    await session?.zip(undefined, 'artifacts');
    await session?.clean();
  });

  it('pushes to initiate the remote', () => {
    execCmd('force:source:push', { ensureExitCode: 0 });
  });
  it('edits a remote file', async () => {
    const conn = await Connection.create({
      authInfo: await AuthInfo.create({ username: session.setup[0].result?.username as string }),
    });
    const app = await conn.singleRecordQuery<{ Id: string; Metadata: any }>(
      "select Id, Metadata from CustomApplication where DeveloperName = 'EBikes'",
      {
        tooling: true,
      }
    );
    await conn.tooling.sobject('CustomApplication').update({
      ...app,
      Metadata: {
        ...app.Metadata,
        description: 'modified',
      },
    });
    const result = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 }).jsonOutput
      .result;
    // profile and customApplication
    expect(result).to.have.lengthOf(2);
  });
  it('edits a local file', async () => {
    const filePath = path.join(
      session.project.dir,
      'force-app',
      'main',
      'default',
      'applications',
      'Ebikes.app-meta.xml'
    );
    await fs.promises.writeFile(
      filePath,
      (await fs.promises.readFile(filePath, { encoding: 'utf-8' })).replace('Lightning App Builder', 'App Builder')
    );
  });
  it('can see the conflict in status', () => {
    const result = execCmd<StatusResult[]>('force:source:status --json', { ensureExitCode: 0 }).jsonOutput.result;
    expect(result).to.have.lengthOf(3);
    result.filter((app) => app.type === 'CustomApplication').map((app) => expect(app.state).to.include('(Conflict)'));
  });

  it('gets conflict error on push', () => {
    execCmd<StatusResult[]>('force:source:push --json', { ensureExitCode: 1 });
  });
  it('gets conflict error on pull', () => {
    execCmd<StatusResult[]>('force:source:pull --json', { ensureExitCode: 1 });
  });
  it('can push with forceoverwrite', () => {
    execCmd<StatusResult[]>('force:source:push --json --forceoverwrite', { ensureExitCode: 0 });
  });
});
