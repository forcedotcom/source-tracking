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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MockTestOrgData, instantiateContext, restoreContext, stubContext } from '@salesforce/core/testSetup';
import { envVars, Lifecycle, Org } from '@salesforce/core';
import { ComponentStatus, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import { isUndefined } from 'effect/Predicate';
import {
  deleteRemoteTracking,
  initializeRemoteTracking,
  makeRemoteTrackingCaches,
  remoteChangeElementToChangeResult,
  resetRemoteTracking,
  retrieveRemoteChanges,
  updateRemoteTracking,
} from '../../../src/shared/remote/remoteSourceTracking.js';
import { getFilePath, readFileContents, writeTrackingFile } from '../../../src/shared/remote/fileOperations.js';
import { sourceMemberQueries } from '../../../src/shared/remote/orgQueries.js';
import {
  getSourceMember,
  setMemberRevision,
  emptyRemoteTrackingState,
} from '../../../src/shared/remote/remoteTrackingState.js';
import type { RemoteTrackingIdentity } from '../../../src/shared/remote/fileOperations.js';
import type { ContentsV1, MemberRevision, SourceMember } from '../../../src/shared/remote/types.js';
import type { RemoteChangeElement, RemoteSyncInput } from '../../../src/shared/types.js';

const defaultSourceMember: SourceMember = {
  IsNewMember: false,
  IsNameObsolete: false,
  RevisionCounter: 1,
  MemberType: 'ApexClass',
  MemberName: 'MyClass',
  ChangedBy: 'Shelby McLaughlin',
  MemberIdOrName: '00eO4000003cP5JIAU',
  LastModifiedDate: '2026-01-01T00:00:00.000Z',
};

const sourceMember = (revision: number, memberName = `MyClass${revision}`): SourceMember => ({
  ...defaultSourceMember,
  RevisionCounter: revision,
  MemberName: memberName,
});

const memberRevision = (revision: number, lastRetrievedFromServer?: number): MemberRevision => ({
  ...sourceMember(revision),
  lastRetrievedFromServer,
});

const reResolveEnvVars = (): void => {
  // @ts-expect-error test setup forces EnvVars to resolve updated process values
  envVars.resolve(); // eslint-disable-line @typescript-eslint/no-unsafe-call
};

describe('remote source tracking Effects', () => {
  const $$ = instantiateContext();
  let org: Org;
  let identity: RemoteTrackingIdentity;
  let projectPath: string;

  const writeSnapshot = async (
    serverMaxRevisionCounter: number,
    sourceMembers: Record<string, MemberRevision>
  ): Promise<void> => {
    await Effect.runPromise(
      writeTrackingFile({
        filePath: getFilePath(identity),
        maxCounter: serverMaxRevisionCounter,
        members: new Map(Object.entries(sourceMembers)),
      })
    );
  };

  const readSnapshot = async (): Promise<ContentsV1> => {
    const contents = await Effect.runPromise(readFileContents(getFilePath(identity)));
    if (!('sourceMembers' in contents)) throw new Error('expected initialized remote tracking file');
    return contents;
  };

  beforeEach(async () => {
    stubContext($$);
    const orgData = new MockTestOrgData();
    orgData.username = 'foo@bar.com';
    orgData.tracksSource = true;
    await $$.stubAuths(orgData);
    org = await Org.create({ aliasOrUsername: orgData.username });
    $$.SANDBOX.stub(org, 'supportsSourceTracking').resolves(true);
    projectPath = await mkdtemp(path.join(tmpdir(), 'source-tracking-remote-'));
    identity = { projectPath, orgId: org.getOrgId() };
    await Effect.runPromise(initializeRemoteTracking({ org, identity }));
  });

  afterEach(async () => {
    envVars.unset('SF_DISABLE_SOURCE_MEMBER_POLLING');
    envVars.unset('SFDX_DISABLE_SOURCE_MEMBER_POLLING');
    envVars.unset('SF_SOURCE_MEMBER_POLLING_TIMEOUT');
    envVars.unset('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT');
    reResolveEnvVars();
    restoreContext($$);
    await rm(projectPath, { recursive: true, force: true });
  });

  describe('remoteChangeElementToChangeResult', () => {
    const registry = new RegistryAccess();
    const toChangeResult = remoteChangeElementToChangeResult(registry);

    it('keeps EmailTemplateFolder names and maps the type', () => {
      const element: RemoteChangeElement = {
        name: 'level1/level2/level3',
        type: 'EmailTemplateFolder',
        deleted: false,
        modified: true,
        changedBy: 'Shelby McLaughlin',
        revisionCounter: 1,
        memberIdOrName: '00eO4000003cP5J',
        lastModifiedDate: defaultSourceMember.LastModifiedDate,
      };
      expect(toChangeResult(element)).to.deep.equal({
        ...element,
        origin: 'remote',
        type: 'EmailFolder',
      });
    });

    it('reduces bundle member names to the bundle name', () => {
      const element: RemoteChangeElement = {
        name: 'fooLWC/bar',
        type: 'LightningComponentResource',
        deleted: false,
        modified: true,
        changedBy: 'Shelby McLaughlin',
        revisionCounter: 1,
        memberIdOrName: '00eO4000003cP5J',
        lastModifiedDate: defaultSourceMember.LastModifiedDate,
      };
      expect(toChangeResult(element)).to.deep.equal({
        ...element,
        origin: 'remote',
        name: 'fooLWC',
        type: 'LightningComponentBundle',
      });
    });
  });

  it('retrieves and persists new SourceMembers and reports unsynced changes', async () => {
    const queryStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom').returns(
      Effect.succeed([sourceMember(1)])
    );

    const changes = await Effect.runPromise(retrieveRemoteChanges({ org, identity }));

    expect(queryStub.calledOnce).to.equal(true);
    expect(changes.map(({ name, type }) => ({ name, type }))).to.deep.equal([{ name: 'MyClass1', type: 'ApexClass' }]);
    const contents = await readSnapshot();
    expect(contents.serverMaxRevisionCounter).to.equal(1);
    expect(contents.sourceMembers['ApexClass###MyClass1'].lastRetrievedFromServer).to.equal(undefined);
  });

  it('coalesces concurrent identical SourceMember lookups in the Effect cache', async () => {
    const cache = await Effect.runPromise(makeRemoteTrackingCaches({ org, identity }));
    const queryStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom').returns(
      Effect.succeed([sourceMember(1)])
    );

    await Effect.runPromise(
      Effect.all(
        [
          retrieveRemoteChanges({ org, identity, queryCache: cache }),
          retrieveRemoteChanges({ org, identity, queryCache: cache }),
        ],
        { concurrency: 'unbounded' }
      )
    );

    expect(queryStub.calledOnce).to.equal(true);
  });

  it('returns only revisions that have not been retrieved from the server', async () => {
    await writeSnapshot(3, {
      'CustomObject###test__c': {
        ...memberRevision(2, 3),
        MemberType: 'CustomObject',
        MemberName: 'test__c',
        MemberIdOrName: 'test__c',
      },
      'ApexClass###synced': {
        ...memberRevision(2, 2),
        MemberName: 'synced',
      },
    });
    $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom').returns(Effect.succeed([]));

    const changes = await Effect.runPromise(retrieveRemoteChanges({ org, identity }));

    expect(changes.map(({ name, type }) => ({ name, type }))).to.deep.equal([
      { name: 'test__c', type: 'CustomObject' },
    ]);
  });

  it('syncs specified elements into the same persisted snapshot', async () => {
    await writeSnapshot(1, {
      'Profile###my(awesome)profile': {
        ...memberRevision(1),
        MemberType: 'Profile',
        MemberName: 'my(awesome)profile',
      },
    });
    const elements: RemoteSyncInput[] = [
      {
        fullName: 'my(awesome)profile',
        type: 'Profile',
        filePath: 'my%28awesome%29profile.profile-meta.xml',
        state: ComponentStatus.Changed,
      },
    ];

    await Effect.runPromise(
      updateRemoteTracking({ org, identity, registry: new RegistryAccess(), elements, skipPolling: true })
    );

    expect((await readSnapshot()).sourceMembers['Profile###my(awesome)profile'].lastRetrievedFromServer).to.equal(1);
  });

  it('syncs encoded stored keys through decoded-key resolution', async () => {
    const encodedKey = 'Layout###Broker__c-v1%2E1 Broker Layout';
    const fileVersion = process.env.SF_SOURCE_TRACKING_FILE_VERSION;
    process.env.SF_SOURCE_TRACKING_FILE_VERSION = '1';
    try {
      await writeSnapshot(2, {
        [encodedKey]: {
          ...memberRevision(2, 1),
          MemberType: 'Layout',
          MemberName: 'Broker__c-v1.1 Broker Layout',
        },
      });

      const elements: RemoteSyncInput[] = [
        {
          fullName: 'Broker__c-v1.1 Broker Layout',
          type: 'Layout',
          filePath: 'Broker__c-v1.1 Broker Layout.layout-meta.xml',
          state: ComponentStatus.Changed,
        },
      ];
      await Effect.runPromise(
        updateRemoteTracking({ org, identity, registry: new RegistryAccess(), elements, skipPolling: true })
      );

      const contents = await readSnapshot();
      expect(contents.sourceMembers).to.have.all.keys(encodedKey);
      expect(contents.sourceMembers[encodedKey].lastRetrievedFromServer).to.equal(2);
    } finally {
      if (isUndefined(fileVersion)) delete process.env.SF_SOURCE_TRACKING_FILE_VERSION;
      else process.env.SF_SOURCE_TRACKING_FILE_VERSION = fileVersion;
    }
  });

  it('polls SourceMember batches, then syncs and writes one completed snapshot', async () => {
    const queryStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom');
    queryStub.onFirstCall().returns(Effect.succeed([]));
    queryStub.onSecondCall().returns(Effect.succeed([sourceMember(4, 'MyClass'), sourceMember(5, 'Bonus')]));
    const pollingEventSpy = $$.SANDBOX.spy(Lifecycle.getInstance(), 'emit');
    const telemetryStub = $$.SANDBOX.stub(Lifecycle.getInstance(), 'emitTelemetry').resolves();
    const elements: RemoteSyncInput[] = [
      { fullName: 'MyClass', type: 'ApexClass', filePath: 'MyClass.cls', state: ComponentStatus.Changed },
    ];

    const startedAt = performance.now();
    await Effect.runPromise(updateRemoteTracking({ org, identity, registry: new RegistryAccess(), elements }));

    expect(queryStub.callCount).to.equal(2);
    expect(performance.now() - startedAt).to.be.at.least(900);
    const contents = await readSnapshot();
    expect(contents.serverMaxRevisionCounter).to.equal(5);
    expect(contents.sourceMembers['ApexClass###MyClass'].lastRetrievedFromServer).to.equal(4);
    expect(contents.sourceMembers['ApexClass###Bonus'].lastRetrievedFromServer).to.equal(undefined);
    expect(pollingEventSpy.calledWith('sourceMemberPollingEvent')).to.equal(true);
    expect(telemetryStub.calledWithMatch({ eventName: 'sourceMemberBonusTypes' })).to.equal(true);
  });

  it('emits a warning and persists partial state when polling times out', async () => {
    envVars.setString('SF_SOURCE_MEMBER_POLLING_TIMEOUT', '1');
    reResolveEnvVars();
    const warnings: string[] = [];
    Lifecycle.getInstance().onWarning((warning) => {
      warnings.push(warning);
      return Promise.resolve();
    });
    const telemetryStub = $$.SANDBOX.stub(Lifecycle.getInstance(), 'emitTelemetry').resolves();
    const queryStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom');
    queryStub.onFirstCall().returns(Effect.succeed([sourceMember(4, 'ArrivedBeforeTimeout')]));
    queryStub.returns(Effect.succeed([]));
    const elements: RemoteSyncInput[] = [
      { fullName: 'MyClass', type: 'ApexClass', filePath: 'MyClass.cls', state: ComponentStatus.Changed },
    ];

    await Effect.runPromise(updateRemoteTracking({ org, identity, registry: new RegistryAccess(), elements }));

    expect(queryStub.called).to.equal(true);
    expect(warnings.some((warning) => warning.includes('Polling for 1 SourceMembers timed out'))).to.equal(true);
    expect(warnings.some((warning) => warning.includes('after 2 attempts (last 1 were empty)'))).to.equal(true);
    expect(telemetryStub.calledWithMatch({ eventName: 'sourceMemberPollingTimeout' })).to.equal(true);
    const contents = await readSnapshot();
    expect(contents.serverMaxRevisionCounter).to.equal(4);
    expect(contents.sourceMembers['ApexClass###ArrivedBeforeTimeout']).to.be.an('object');
  });

  it('does not query while polling is disabled', async () => {
    envVars.setString('SF_DISABLE_SOURCE_MEMBER_POLLING', 'true');
    reResolveEnvVars();
    const queryStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom').returns(Effect.succeed([]));
    const elements: RemoteSyncInput[] = [
      { fullName: 'MyClass', type: 'ApexClass', filePath: 'MyClass.cls', state: ComponentStatus.Changed },
    ];

    await Effect.runPromise(updateRemoteTracking({ org, identity, registry: new RegistryAccess(), elements }));

    expect(queryStub.called).to.equal(false);
  });

  it('resets to the current org snapshot and marks returned SourceMembers synced', async () => {
    const queryStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom').returns(
      Effect.succeed([sourceMember(1), sourceMember(2)])
    );

    const members = await Effect.runPromise(resetRemoteTracking({ org, identity }));

    expect(queryStub.calledOnce).to.equal(true);
    expect(members).to.deep.equal(['ApexClass###MyClass1', 'ApexClass###MyClass2']);
    const contents = await readSnapshot();
    expect(contents.serverMaxRevisionCounter).to.equal(2);
    expect(contents.sourceMembers['ApexClass###MyClass2'].lastRetrievedFromServer).to.equal(2);
  });

  it('resets only through the requested revision', async () => {
    const queryToStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersTo').returns(
      Effect.succeed([sourceMember(1), sourceMember(3)])
    );
    const queryFromStub = $$.SANDBOX.stub(sourceMemberQueries, 'querySourceMembersFrom').returns(Effect.succeed([]));

    await Effect.runPromise(resetRemoteTracking({ org, identity, toRevision: 3 }));

    expect(queryToStub.calledOnce).to.equal(true);
    expect(queryFromStub.called).to.equal(false);
    expect((await readSnapshot()).serverMaxRevisionCounter).to.equal(3);
  });

  it('keeps the project path in the tracking-file identity and deletes only that file', async () => {
    const otherProjectPath = await mkdtemp(path.join(tmpdir(), 'source-tracking-other-project-'));
    const otherIdentity = { projectPath: otherProjectPath, orgId: identity.orgId };
    await Effect.runPromise(initializeRemoteTracking({ org, identity: otherIdentity }));

    expect(getFilePath(identity)).not.to.equal(getFilePath(otherIdentity));
    const deletedPath = await Effect.runPromise(deleteRemoteTracking(identity));
    expect(deletedPath).to.equal(getFilePath(identity));
    expect(await Effect.runPromise(readFileContents(getFilePath(otherIdentity)))).to.have.property('sourceMembers');
    await rm(otherProjectPath, { recursive: true, force: true });
  });

  describe('explicit snapshot key resolution', () => {
    it('reads and updates URI-encoded metadata keys without changing the stored key', () => {
      const state = emptyRemoteTrackingState();
      state.sourceMembers.set('Layout###Broker__c-v1%2E1 Broker Layout', {
        ...memberRevision(2, 1),
        MemberType: 'Layout',
        MemberName: 'Broker__c-v1.1 Broker Layout',
      });

      expect(getSourceMember(state, 'Layout###Broker__c-v1.1 Broker Layout')?.RevisionCounter).to.equal(2);
      setMemberRevision(state, 'Layout###Broker__c-v1.1 Broker Layout', {
        ...memberRevision(3, 1),
        MemberType: 'Layout',
        MemberName: 'Broker__c-v1.1 Broker Layout',
      });

      expect(state.sourceMembers.size).to.equal(1);
      expect(state.sourceMembers.get('Layout###Broker__c-v1%2E1 Broker Layout')?.RevisionCounter).to.equal(3);
    });

    it('returns no match for a malformed URI-encoded lookup key', () => {
      expect(getSourceMember(emptyRemoteTrackingState(), 'Layout###Broker__c-%E0%A4%A')).to.equal(undefined);
    });

    it('skips malformed persisted keys when building the decoded-key index', () => {
      const state = emptyRemoteTrackingState();
      const malformedKey = 'Layout###Broker__c-%E0%A4%A';
      const revision = {
        ...memberRevision(1),
        MemberType: 'Layout',
        MemberName: 'Broker__c-%E0%A4%A',
      };
      state.sourceMembers.set(malformedKey, revision);

      expect(() => getSourceMember(state, 'Layout###missing')).not.to.throw();
      expect(getSourceMember(state, malformedKey)).to.deep.equal(revision);
    });
  });
});
