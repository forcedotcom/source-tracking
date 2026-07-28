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
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { Lifecycle, Org, SfProject } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { SourceTracking } from '../../src/sourceTracking';

describe('platform event source tracking after deploy (@W-21612413@)', () => {
  let session: TestSession;
  let stl: SourceTracking;
  const warnings: string[] = [];

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'repros', 'platformEventTracking'),
      },
      scratchOrgs: [
        {
          config: path.join('config', 'project-scratch-def.json'),
          duration: 1,
          setDefault: true,
          tracksSource: true,
        },
      ],
      devhubAuthStrategy: 'AUTO',
    });

    const org = await Org.create({ aliasOrUsername: session.orgs.get('default')?.username });
    const project = await SfProject.resolve(session.project.dir);
    stl = await SourceTracking.create({ org, project });

    Lifecycle.getInstance().onWarning((w) => {
      warnings.push(w);
      return Promise.resolve();
    });
  });

  after(async () => {
    await session?.clean();
  });

  it('deploys a platform event with a custom field and updates source tracking without timeout', async () => {
    const componentSet = ComponentSet.fromSource(
      path.join(session.project.dir, 'force-app', 'main', 'default', 'objects', 'TestEvent__e')
    );

    const deploy = await componentSet.deploy({ usernameOrConnection: session.orgs.get('default')!.username! });
    const deployResult = await deploy.pollStatus();

    expect(deployResult.response.success, 'deploy should succeed').to.equal(true);

    const fileResponses = deployResult.getFileResponses();
    expect(fileResponses.length).to.be.greaterThan(0);

    await stl.updateTrackingFromDeploy(deployResult);

    const pollingTimeoutWarnings = warnings.filter((w) => w.includes('SourceMembers timed out'));
    expect(pollingTimeoutWarnings, 'source tracking should not time out polling for SourceMembers').to.have.length(0);
  });
});
