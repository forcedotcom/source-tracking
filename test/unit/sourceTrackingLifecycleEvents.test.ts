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
import sinon from 'sinon';
import { expect } from 'chai';
import { MockTestOrgData, instantiateContext, stubContext, restoreContext } from '@salesforce/core/testSetup';
import { Lifecycle, Org, SfProject } from '@salesforce/core';
import { SourceTracking } from '../../src/sourceTracking';
import { ShadowRepo } from '../../src/shared/local/localShadowRepo';

describe('SourceTracking lifecycle events cleanup', () => {
  const $$ = instantiateContext();
  const username = 'test@example.com';

  afterEach(() => {
    restoreContext($$);
    sinon.restore();
  });

  it('removes pre-event listeners when subscribing to lifecycle events', async () => {
    stubContext($$);
    const orgData = new MockTestOrgData();
    orgData.username = username;
    orgData.tracksSource = true;
    await $$.stubAuths(orgData);

    const org = await Org.create({ aliasOrUsername: username });
    const project = SfProject.getInstance();

    sinon.stub(project, 'getPackageDirectories').returns([
      {
        name: 'force-app',
        path: 'force-app',
        fullPath: '/test/force-app',
        default: true,
      },
    ]);

    const lifecycle = Lifecycle.getInstance();
    const removeAllListenersSpy = sinon.spy(lifecycle, 'removeAllListeners');

    await SourceTracking.create({
      org,
      project,
      subscribeSDREvents: true,
    });

    expect(removeAllListenersSpy.calledWith('scopedPreDeploy')).to.equal(true);
    expect(removeAllListenersSpy.calledWith('scopedPreRetrieve')).to.equal(true);
  });

  it('does not remove listeners when subscribeSDREvents is false', async () => {
    stubContext($$);
    const orgData = new MockTestOrgData();
    orgData.username = username;
    orgData.tracksSource = true;
    await $$.stubAuths(orgData);

    const org = await Org.create({ aliasOrUsername: username });
    const project = SfProject.getInstance();

    sinon.stub(project, 'getPackageDirectories').returns([
      {
        name: 'force-app',
        path: 'force-app',
        fullPath: '/test/force-app',
        default: true,
      },
    ]);

    const lifecycle = Lifecycle.getInstance();
    const removeAllListenersSpy = sinon.spy(lifecycle, 'removeAllListeners');

    await SourceTracking.create({
      org,
      project,
      subscribeSDREvents: false,
    });

    expect(removeAllListenersSpy.calledWith('scopedPreDeploy')).to.equal(false);
    expect(removeAllListenersSpy.calledWith('scopedPreRetrieve')).to.equal(false);
  });
});

describe('SourceTracking local tracking initialization', () => {
  const project = {
    getPath: (): string => '/test',
    getPackageDirectories: (): Array<{ name: string; path: string; fullPath: string; default: boolean }> => [],
  };
  const org = { getOrgId: (): string => '00D000000000001' };

  afterEach(() => {
    sinon.restore();
  });

  it('does one forced status scan when rereading a cold local tracking cache', async () => {
    const getStatus = sinon.stub().resolves([]);
    sinon.stub(ShadowRepo, 'getInstance').resolves({ getStatus } as unknown as ShadowRepo);
    const tracking = new SourceTracking({ org: org as Org, project: project as SfProject });

    await tracking.reReadLocalTrackingCache();

    expect(getStatus.calledOnceWithExactly(true)).to.equal(true);
  });

  it('continues to populate status when ensuring cold local tracking', async () => {
    const getStatus = sinon.stub().resolves([]);
    sinon.stub(ShadowRepo, 'getInstance').resolves({ getStatus } as unknown as ShadowRepo);
    const tracking = new SourceTracking({ org: org as Org, project: project as SfProject });

    await tracking.ensureLocalTracking();

    expect(getStatus.calledOnceWithExactly()).to.equal(true);
  });
});
