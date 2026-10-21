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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import { expect } from 'chai';
import { MockTestOrgData, instantiateContext, stubContext, restoreContext } from '@salesforce/core/testSetup';
import { Lifecycle, Logger, Org, SfProject } from '@salesforce/core';
import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { SourceTracking } from '../../src/sourceTracking.js';

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

  it('coalesces concurrent local tracking initialization and uses the injected Crypto layer', async () => {
    stubContext($$);
    const orgData = new MockTestOrgData();
    orgData.username = username;
    orgData.tracksSource = true;
    await $$.stubAuths(orgData);

    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'source-tracking-init-'));
    fs.mkdirSync(path.join(projectPath, 'force-app'), { recursive: true });
    const org = await Org.create({ aliasOrUsername: username });
    const orgId = org.getOrgId();
    const project = SfProject.getInstance();
    sinon.stub(project, 'getPath').returns(projectPath);
    sinon.stub(project, 'getPackageDirectories').returns([
      {
        name: 'force-app',
        path: 'force-app',
        fullPath: path.join(projectPath, 'force-app'),
        default: true,
      },
    ]);
    const loggerChildStub = Reflect.get(Logger, 'child') as unknown as { callCount: number };
    const loggerChildCallCount = loggerChildStub.callCount;
    const crypto = await Effect.runPromise(Crypto.Crypto.pipe(Effect.provide(NodeCrypto.layer)));
    const digest = sinon.spy((algorithm: Crypto.DigestAlgorithm, bytes: Uint8Array) => crypto.digest(algorithm, bytes));
    const cryptoLayer = Layer.succeed(Crypto.Crypto, { ...crypto, digest });

    try {
      const sourceTracking = await SourceTracking.create({ org, project, cryptoLayer });
      await Promise.all([sourceTracking.ensureLocalTracking(), sourceTracking.ensureLocalTracking()]);
      expect(loggerChildStub.callCount - loggerChildCallCount).to.equal(1);
      expect(digest.called).to.equal(true);
      expect(digest.getCalls().every((call) => call.args[0] === 'SHA-1')).to.equal(true);
      expect(
        fs.existsSync(path.join(projectPath, '.sf', 'orgs', orgId, 'localSourceTracking', 'refs', 'heads', 'main'))
      ).to.equal(true);
    } finally {
      await fs.promises.rm(projectPath, { recursive: true, force: true });
    }
  });
});
