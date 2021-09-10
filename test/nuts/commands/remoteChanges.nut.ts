/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import * as path from 'path';
import * as fs from 'fs';

import { TestSession, execCmd } from '@salesforce/cli-plugins-testkit';
import { Connection, AuthInfo } from '@salesforce/core';
import { expect } from 'chai';
import { StatusResult } from '../../../src/commands/force/source/status';
import { PushPullResponse } from '../../../src/shared/types';

let session: TestSession;
let conn: Connection;

describe('remote changes', () => {
  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
      },
      setupCommands: [`sfdx force:org:create -d 1 -s -f ${path.join('config', 'project-scratch-def.json')}`],
    });
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

  describe('remote changes: delete', () => {
    it('pushes to initiate the remote', () => {
      const pushResult = execCmd<PushPullResponse[]>('force:source:push --json', { ensureExitCode: 0 }).jsonOutput
        .result;
      expect(pushResult, JSON.stringify(pushResult)).to.have.lengthOf(234);
    });

    it('deletes on the server', async () => {
      const testClass = await conn.singleRecordQuery<{ Id: string }>(
        "select Id from ApexClass where Name = 'TestOrderController'",
        {
          tooling: true,
        }
      );
      const deleteResult = await conn.tooling.delete('ApexClass', testClass.Id);
      if (!Array.isArray(deleteResult) && deleteResult.success) {
        expect(deleteResult.id).to.be.a('string');
      }
    });
    it('local file is present', () => {
      expect(
        fs.existsSync(
          path.join(session.project.dir, 'force-app', 'main', 'default', 'classes', 'TestOrderController.cls')
        )
      ).to.equal(true);
      expect(
        fs.existsSync(
          path.join(session.project.dir, 'force-app', 'main', 'default', 'classes', 'TestOrderController.cls-meta.xml')
        )
      ).to.equal(true);
    });
    it('can see the delete in status', () => {
      const result = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 }).jsonOutput
        .result;
      // it shows up as one class on the server, but 2 files when pulled
      expect(result.filter((r) => r.state.includes('Delete'))).to.have.length(1);
    });
    it('does not see any change in local status', () => {
      const result = execCmd<StatusResult[]>('force:source:status --json --local', { ensureExitCode: 0 }).jsonOutput
        .result;
      expect(result).to.have.length(0);
    });
    it('can pull the delete', () => {
      const result = execCmd<StatusResult[]>('force:source:pull --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(result).to.have.length(3); // profile plus the 2 files for the apexClass
      result.filter((r) => r.fullName === 'TestOrderController').map((r) => expect(r.state).to.equal('Deleted'));
    });
    it('local file was deleted', () => {
      expect(
        fs.existsSync(
          path.join(session.project.dir, 'force-app', 'main', 'default', 'classes', 'TestOrderController.cls')
        )
      ).to.equal(false);
      expect(
        fs.existsSync(
          path.join(session.project.dir, 'force-app', 'main', 'default', 'classes', 'TestOrderController.cls-meta.xml')
        )
      ).to.equal(false);
    });
    it('sees correct local and remote status', () => {
      const remoteResult = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 })
        .jsonOutput.result;
      expect(remoteResult.filter((r) => r.state.includes('Remote Deleted'))).to.have.length(0);

      const localStatus = execCmd<StatusResult[]>('force:source:status --json --local', { ensureExitCode: 0 })
        .jsonOutput.result;
      expect(localStatus).to.have.length(0);
    });
  });

  describe('remote changes: add', () => {
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
    it('can see the add in status', () => {
      const result = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 }).jsonOutput
        .result;
      // it shows up as one class on the server, plus Admin Profile
      expect(result.filter((r) => r.state.includes('Add'))).to.have.length(2);
      expect(result.some((r) => r.fullName === 'CreatedClass')).to.equal(true);
    });
    it('can pull the add', () => {
      const result = execCmd<StatusResult[]>('force:source:pull --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(result).to.have.length(3); // 2 files for the apexClass, plus AdminProfile
      // SDR marks all retrieves as 'Changed' even if it creates new local files.  This is different from toolbelt, which marked those as 'Created'
      result.filter((r) => r.fullName === 'CreatedClass').map((r) => expect(r.state).to.equal('Changed'));
    });
    it('sees correct local and remote status', () => {
      const remoteResult = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 })
        .jsonOutput.result;
      expect(remoteResult).to.have.length(0);

      const localStatus = execCmd<StatusResult[]>('force:source:status --json --local', { ensureExitCode: 0 })
        .jsonOutput.result;
      expect(localStatus).to.have.length(0);
    });
  });

  describe('remote changes: mixed', () => {
    it('all three types of changes on the server');
    it('can see the changes in status');
    it('can pull the changes');
    it('sees correct local and remote status');
  });
});
