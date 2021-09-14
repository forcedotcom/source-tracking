/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/* eslint-disable no-console */

import * as path from 'path';
import * as fs from 'fs';
import { expect } from 'chai';

import { TestSession, execCmd } from '@salesforce/cli-plugins-testkit';
import { Env } from '@salesforce/kit';
import { ensureString } from '@salesforce/ts-types';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';

import { DeployCommandResult } from '@salesforce/plugin-source/lib/formatters/deployResultFormatter';
import { StatusResult } from '../../../src/commands/force/source/status';
import { PullResponse } from '../../../src/shared/types';

let session: TestSession;
let hubUsername: string;
describe('end-to-end-test for tracking with an org (single packageDir)', () => {
  const env = new Env();

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'ebikes-lwc'),
      },
      setupCommands: [`sfdx force:org:create -d 1 -s -f ${path.join('config', 'project-scratch-def.json')}`],
    });
    hubUsername = ensureString(env.getString('TESTKIT_HUB_USERNAME'));
  });

  after(async () => {
    await session?.zip(undefined, 'artifacts');
    await session?.clean();
  });

  describe('basic status and pull', () => {
    it('detects the initial metadata status', () => {
      const result = execCmd<StatusResult[]>('force:source:status --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(result).to.be.an.instanceof(Array);
      // the fields should be populated
      expect(result.every((row) => row.type && row.fullName)).to.equal(true);
    });
    it('pushes the initial metadata to the org', () => {
      const result = execCmd<DeployCommandResult>('force:source:push --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(result.deployedSource).to.be.an.instanceof(Array);
      expect(result.deployedSource, JSON.stringify(result)).to.have.lengthOf(234);
      expect(
        result.deployedSource.every((r) => r.state !== ComponentStatus.Failed),
        JSON.stringify(result)
      ).to.equal(true);
    });
    it('sees no local changes (all were committed from push), but profile updated in remote', () => {
      const localResult = execCmd<StatusResult[]>('force:source:status --json --local', { ensureExitCode: 0 })
        .jsonOutput.result;
      expect(localResult).to.deep.equal([]);

      const remoteResult = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 })
        .jsonOutput.result;
      expect(remoteResult.length).to.equal(1);
      expect(remoteResult.some((item) => item.type === 'Profile')).to.equal(true);
    });

    it('can pull the remote profile', () => {
      const pullResult = execCmd<PullResponse[]>('force:source:pull --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(pullResult.some((item) => item.type === 'Profile')).to.equal(true);
    });

    it('sees no local or remote changes', () => {
      const result = execCmd<StatusResult[]>('force:source:status --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(result).to.have.length(0);
    });

    it('sees a local delete in local status', async () => {
      const classDir = path.join(session.project.dir, 'force-app', 'main', 'default', 'classes');
      await Promise.all([
        fs.promises.unlink(path.join(classDir, 'TestOrderController.cls')),
        fs.promises.unlink(path.join(classDir, 'TestOrderController.cls-meta.xml')),
      ]);
      const result = execCmd<StatusResult[]>('force:source:status --json --local', { ensureExitCode: 0 }).jsonOutput
        .result;
      expect(result).to.deep.equal([
        {
          type: 'ApexClass',
          state: 'local Delete',
          fullName: 'TestOrderController',
          filepath: 'force-app/main/default/classes/TestOrderController.cls',
        },
        {
          type: 'ApexClass',
          state: 'local Delete',
          fullName: 'TestOrderController',
          filepath: 'force-app/main/default/classes/TestOrderController.cls-meta.xml',
        },
      ]);
    });
    it('does not see any change in remote status', () => {
      const result = execCmd<StatusResult[]>('force:source:status --json --remote', { ensureExitCode: 0 }).jsonOutput
        .result;
      expect(result).to.have.length(0);
    });

    it('pushes the local delete to the org', () => {
      const result = execCmd<DeployCommandResult>('force:source:push --json', { ensureExitCode: 0 }).jsonOutput.result;
      expect(result.deployedSource).to.be.an.instanceof(Array).with.length(2);
    });
    it('sees no local changes', () => {
      const result = execCmd<StatusResult[]>('force:source:status --json --local', { ensureExitCode: 0 }).jsonOutput
        .result;
      expect(result).to.be.an.instanceof(Array).with.length(0);
    });
  });

  describe('non-successes', () => {
    it('should throw an err when attempting to pull from a non scratch-org', () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const failure = execCmd(`force:source:status -u ${hubUsername} --remote --json`, {
        ensureExitCode: 1,
      }).jsonOutput;
      expect(failure.name).to.equal('NonSourceTrackedOrgError');
    });
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
