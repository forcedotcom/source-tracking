/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/* eslint-disable no-console */

import * as path from 'path';
import * as fs from 'fs';

import { TestSession, execCmd } from '@salesforce/cli-plugins-testkit';
import { FileResponse } from '@salesforce/source-deploy-retrieve';
import { expect } from 'chai';
import { StatusResult } from '../../../src/commands/source/status';

let session: TestSession;

describe('end-to-end-test for tracking with an org (single packageDir)', () => {
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
    // await session?.clean();
  });

  describe('basic status and pull', () => {
    it('detects the initial metadata status', () => {
      const result = execCmd<StatusResult[]>('source:status --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(result).to.be.an.instanceof(Array);
      // the fields should be populated
      expect(result.every((row) => row.type && row.fullName)).to.equal(true);
    });
    it('pushes the initial metadata to the org', () => {
      const result = execCmd<FileResponse[]>('source:push --json', { ensureExitCode: 0 }).jsonOutput.result;
      // console.log(result);
      expect(result).to.be.an.instanceof(Array);
    });
    it('sees no local changes (all were committed from push), but profile updated in remote', () => {
      const localResult = execCmd<StatusResult[]>('source:status --json --local', { ensureExitCode: 0 }).jsonOutput
        .result;
      // console.log(localResult);
      expect(localResult).to.deep.equal([]);

      const remoteResult = execCmd<StatusResult[]>('source:status --json --remote', { ensureExitCode: 0 }).jsonOutput
        .result;
      // console.log(remoteResult);
      expect(remoteResult.length).to.equal(1);
      expect(remoteResult.some((item) => item.type === 'Profile')).to.equal(true);
      // expect(remoteResult.some((item) => item.type === 'FieldRestrictionRule')).to.equal(true);
      // expect(remoteResult.some((item) => item.type === 'Audience')).to.equal(true);
    });

    it('can pull the remote profile', () => {
      const pullResult = execCmd<FileResponse[]>('source:pull --json', { ensureExitCode: 0 }).jsonOutput.result;
      console.log(pullResult);
      expect(pullResult.some((item) => item.type === 'Profile')).to.equal(true);
    });

    it('sees no local or remote changes', () => {
      const result = execCmd<StatusResult[]>('source:status --json', { ensureExitCode: 0 }).jsonOutput.result;
      console.log(result);
      expect(result).to.have.length(0);
    });

    it('sees a local delete in local status', async () => {
      const classDir = path.join(session.project.dir, 'force-app', 'main', 'default', 'classes');
      await Promise.all([
        fs.promises.rm(path.join(classDir, 'TestOrderController.cls')),
        fs.promises.rm(path.join(classDir, 'TestOrderController.cls-meta.xml')),
      ]);
      const result = execCmd<StatusResult[]>('source:status --json --local', { ensureExitCode: 0 }).jsonOutput.result;
      console.log(result);
      expect(result).to.deep.equal([]);
    });
    it('does not see any change in remote status', () => {
      const result = execCmd<StatusResult[]>('source:status --json --remote', { ensureExitCode: 0 }).jsonOutput.result;
      console.log(result);
      expect(result).to.have.length(0);
    });

    it('pushes the local delete to the org');
    it('sees no local or remote changes');
  });

  describe('non-successes', () => {
    it('should throw an err when attempting to pull from a non scratch-org');
    it('should not poll for SourceMembers when SFDX_DISABLE_SOURCE_MEMBER_POLLING=true');

    describe('push partial success', () => {
      it('can deploy source with some failures and show correct exit code');
      it('can see failures remaining in local tracking, but successes are gone');
    });

    describe('push failures', () => {
      it('handles failed push');
      it('has no changes to local tracking');
    });
  });
});
