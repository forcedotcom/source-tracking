/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable camelcase */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { sep, dirname } from 'node:path';
import { MockTestOrgData, instantiateContext, stubContext, restoreContext } from '@salesforce/core/testSetup';
import { EnvVars, envVars, Messages, Org } from '@salesforce/core';
import { expect, config } from 'chai';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import {
  RemoteSourceTrackingService,
  remoteChangeElementToChangeResult,
} from '../../../src/shared/remote/remoteSourceTrackingService';
import { RemoteSyncInput, RemoteChangeElement } from '../../../src/shared/types';

import * as orgQueryMocks from '../../../src/shared/remote/orgQueries';

import { getMetadataNameFromKey, getMetadataTypeFromKey } from '../../../src/shared/functions';
import { ContentsV0, MemberRevision, MemberRevisionLegacy, SourceMember } from '../../../src/shared/remote/types';
import { upgradeFileContents } from '../../../src/shared/remote/fileOperations';

config.truncateThreshold = 0;

Messages.importMessagesDirectory(__dirname);

const defaultSourceMemberValues = {
  IsNewMember: false,
  RevisionCounter: 1,
  ChangedBy: 'Shelby McLaughlin',
  MemberIdOrName: '00eO4000003cP5JIAU',
} satisfies Partial<SourceMember>;

const getSourceMember = (revision: number, isDeleted = false): SourceMember => ({
  ...defaultSourceMemberValues,
  RevisionCounter: revision,
  MemberType: 'ApexClass',
  MemberName: `MyClass${revision}`,
  IsNameObsolete: isDeleted,
  MemberIdOrName: '00eO4000003cP5JIAU',
});

const getMemberRevisionEntries = (revision: number, synced = false): { [key: string]: MemberRevision } => {
  const sourceMemberEntries = {} as { [key: string]: MemberRevision };
  for (let i = 1; i <= revision; i++) {
    sourceMemberEntries[`ApexClass###MyClass${i}`] = {
      ...defaultSourceMemberValues,
      RevisionCounter: i,
      lastRetrievedFromServer: synced ? i : undefined,
      MemberType: 'ApexClass',
      MemberName: `MyClass${i}`,
      IsNameObsolete: false,
    };
  }
  return sourceMemberEntries;
};

const reResolveEnvVars = (): void => {
  /* eslint-disable @typescript-eslint/no-unsafe-call */
  // @ts-ignore to force a re-resolve
  envVars.resolve();
  /* eslint-enable @typescript-eslint/no-unsafe-call */
};

type SetContentsInput = {
  serverMaxRevisionCounter: number;
  sourceMembers: { [key: string]: MemberRevision };
};
describe('remoteSourceTrackingService', () => {
  const username = 'foo@bar.com';
  let orgId: string;
  const $$ = instantiateContext();
  let remoteSourceTrackingService: RemoteSourceTrackingService;

  /** a shared "cheater" method to do illegal operations for test setup purposes */
  const setContents = (contents: SetContentsInput): void => {
    // @ts-expect-error it's private
    remoteSourceTrackingService.serverMaxRevisionCounter = contents.serverMaxRevisionCounter;
    // @ts-expect-error it's private
    remoteSourceTrackingService.sourceMembers = new Map(Object.entries(contents.sourceMembers));
  };

  /** a shared "cheater" method to do illegal operations for test assertion purposes */
  const getContents = (): {
    serverMaxRevisionCounter: number;
    sourceMembers: { [key: string]: MemberRevision };
  } => ({
    // @ts-expect-error it's private
    serverMaxRevisionCounter: remoteSourceTrackingService.serverMaxRevisionCounter,
    // @ts-expect-error it's private
    sourceMembers: Object.fromEntries(remoteSourceTrackingService.sourceMembers),
  });

  afterEach(async () => {
    await RemoteSourceTrackingService.delete(orgId);
    restoreContext($$);
  });

  beforeEach(async () => {
    stubContext($$);
    const orgData = new MockTestOrgData();
    orgId = orgData.orgId;
    orgData.username = username;
    orgData.tracksSource = true;
    await $$.stubAuths(orgData);
    const org = await Org.create({ aliasOrUsername: username });
    $$.SANDBOX.stub(org.getConnection().tooling, 'query').resolves({ records: [], done: true, totalSize: 0 });
    remoteSourceTrackingService = await RemoteSourceTrackingService.getInstance({
      org,
      projectPath: await $$.localPathRetriever($$.id),
    });

    describe('remoteChangeElementToChangeResult()', () => {
      const memberIdOrName = '00eO4000003cP5J';
      it('should return correct ChangeResult for EmailTemplateFolder', () => {
        const rce: RemoteChangeElement = {
          name: 'level1/level2/level3',
          type: 'EmailTemplateFolder',
          deleted: false,
          modified: true,
          changedBy: 'Shelby McLaughlin',
          revisionCounter: 1,
          memberIdOrName,
        };
        const changeResult = remoteChangeElementToChangeResult(rce);
        expect(changeResult).to.deep.equal({
          origin: 'remote',
          name: 'level1/level2/level3',
          type: 'EmailFolder',
          deleted: false,
          modified: true,
          changedBy: 'Shelby McLaughlin',
          revisionCounter: 1,
          memberIdOrName,
        });
      });

      it('should return correct ChangeResult for LightningComponentResource', () => {
        const rce: RemoteChangeElement = {
          name: 'fooLWC/bar',
          type: 'LightningComponentResource',
          deleted: false,
          modified: true,
          changedBy: 'Shelby McLaughlin',
          revisionCounter: 1,
          memberIdOrName,
        };
        const changeResult = remoteChangeElementToChangeResult(rce);
        expect(changeResult).to.deep.equal({
          origin: 'remote',
          name: 'fooLWC',
          type: 'LightningComponentBundle',
          deleted: false,
          modified: true,
          changedBy: 'Shelby McLaughlin',
          revisionCounter: 1,
          memberIdOrName,
        });
      });
    });
  });

  describe('getServerMaxRevision', () => {
    it('should return 0 if file does not exist', () => {
      // @ts-expect-error it's private
      const max = remoteSourceTrackingService.serverMaxRevisionCounter;
      expect(max).to.equal(0);
    });
  });

  describe('init', () => {
    it('should set initial state of contents', async () => {
      // @ts-expect-error it's private
      const queryMembersFromSpy = $$.SANDBOX.spy(RemoteSourceTrackingService.prototype, 'querySourceMembersFrom');
      // @ts-expect-error it's private
      await remoteSourceTrackingService.init();
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.serverMaxRevisionCounter).to.equal(0);
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.sourceMembers).to.deep.equal(new Map());
      // this is run during the beforeEach, but doesn't run again because init already happened
      expect(queryMembersFromSpy.called).to.equal(false);
      // the file should exist after init, with its initial state
      expect(existsSync(remoteSourceTrackingService.filePath)).to.equal(true);
      const fileContents = JSON.parse(await readFile(remoteSourceTrackingService.filePath, 'utf8')) as ContentsV0;
      expect(fileContents.serverMaxRevisionCounter).to.equal(0);
      expect(fileContents.sourceMembers).to.deep.equal({});
    });

    it('should set initial state of contents when a file exists', async () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout###Broker__c-Broker Layout': {
            RevisionCounter: 1,
            lastRetrievedFromServer: 1,
            MemberType: 'Layout',
            IsNameObsolete: false,
          },
          'Layout###Broker__c-v1.1 Broker Layout': {
            RevisionCounter: 2,
            lastRetrievedFromServer: 2,
            MemberType: 'Layout',
            IsNameObsolete: false,
          },
        },
      };
      await mkdir(dirname(remoteSourceTrackingService.filePath), { recursive: true });
      await writeFile(remoteSourceTrackingService.filePath, JSON.stringify(maxJson));
      // @ts-expect-error it's private
      await remoteSourceTrackingService.init();
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.serverMaxRevisionCounter).to.equal(2);
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.sourceMembers.size).to.deep.equal(2);
    });

    it('should set initial state of contents when a file exists but has nothing in it', async () => {
      const maxJson = {};
      await mkdir(dirname(remoteSourceTrackingService.filePath), { recursive: true });
      await writeFile(remoteSourceTrackingService.filePath, JSON.stringify(maxJson));
      // @ts-expect-error it's private
      await remoteSourceTrackingService.init();
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.serverMaxRevisionCounter).to.equal(0);
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.sourceMembers.size).to.deep.equal(0);
    });
  });

  describe('sourceMembers object tests', () => {
    it('will return the correct changed elements based on lastRetrieved and serverRevision numbers', async () => {
      const maxJson = {
        serverMaxRevisionCounter: 3,
        sourceMembers: {
          'CustomObject###test__c': {
            ...defaultSourceMemberValues,
            MemberType: 'CustomObject',
            RevisionCounter: 2,
            lastRetrievedFromServer: 3,
            IsNameObsolete: false,
            MemberIdOrName: 'test__c',
            MemberName: 'test__c',
          },
          'ApexClass###abc': {
            ...defaultSourceMemberValues,
            MemberIdOrName: 'abc',
            MemberName: 'abc',
            MemberType: 'ApexClass',
            RevisionCounter: 2,
            lastRetrievedFromServer: 2,
            IsNameObsolete: false,
          },
        },
      } satisfies SetContentsInput;
      setContents(maxJson);
      const changes = await remoteSourceTrackingService.retrieveUpdates();
      expect(changes.length).to.equal(1);
      expect(changes[0].name).to.equal('test__c');
      expect(changes[0].type).to.equal('CustomObject');
    });

    it('will upsert SourceMembers objects correctly', async () => {
      const sm1 = {
        ...defaultSourceMemberValues,
        MemberType: 'ApexClass',
        MemberName: 'test1__c',
        IsNameObsolete: false,
        RevisionCounter: 1,
      } satisfies SourceMember;
      const sm2 = {
        ...defaultSourceMemberValues,
        MemberType: 'ApexClass',
        MemberName: 'test2__c',
        IsNameObsolete: true,
        RevisionCounter: 2,
      } satisfies SourceMember;
      const sourceMemberContainer = [sm1, sm2];
      // @ts-ignore calling a private method from a test
      await remoteSourceTrackingService.trackSourceMembers(sourceMemberContainer);
      const sm = await remoteSourceTrackingService.retrieveUpdates();

      expect(sm.length).to.equal(2);
      expect(sm[0].name).to.equal('test1__c');
      expect(sm[1].name).to.equal('test2__c');
      expect(sm[0].type).to.equal('ApexClass');
      expect(sm[1].type).to.equal('ApexClass');

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember('ApexClass###test1__c')).to.deep.contain({
        ...defaultSourceMemberValues,
        RevisionCounter: 1,
        lastRetrievedFromServer: undefined,
        MemberType: 'ApexClass',
        IsNameObsolete: false,
        MemberName: 'test1__c',
      });

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember('ApexClass###test2__c')).to.deep.contain({
        RevisionCounter: 2,
        lastRetrievedFromServer: undefined,
        MemberType: 'ApexClass',
        IsNameObsolete: true,
        MemberName: 'test2__c',
      });
    });

    it('will match decoded SourceMember keys on get', () => {
      const encodedKey = 'Layout###Broker__c-v1%2E1 Broker Layout';
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout###Broker__c-Broker Layout': {
            ...defaultSourceMemberValues,
            RevisionCounter: 1,
            lastRetrievedFromServer: 1,
            MemberType: 'Layout',
            IsNameObsolete: false,
            MemberName: 'Broker__c-Broker Layout',
          },
          [encodedKey]: {
            ...defaultSourceMemberValues,
            RevisionCounter: 2,
            lastRetrievedFromServer: 2,
            MemberType: 'Layout',
            IsNameObsolete: false,
            MemberName: 'Broker__c-v1.1 Broker Layout',
          },
        },
      } satisfies SetContentsInput;
      setContents(maxJson);

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember(encodedKey)).to.deep.equal({
        ...defaultSourceMemberValues,
        MemberName: 'Broker__c-v1.1 Broker Layout',
        RevisionCounter: 2,
        lastRetrievedFromServer: 2,
        MemberType: 'Layout',
        IsNameObsolete: false,
      });
    });

    it('will match encoded SourceMember keys on get', () => {
      const encodedKey = 'Layout###Broker__c-v1%2E1 Broker Layout';
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout###Broker__c-Broker Layout': {
            ...defaultSourceMemberValues,
            MemberName: getMetadataNameFromKey('Layout###Broker__c-Broker Layout'),
            MemberType: getMetadataTypeFromKey('Layout###Broker__c-Broker Layout'),
            RevisionCounter: 1,
            lastRetrievedFromServer: 1,
            IsNameObsolete: false,
          },
          [encodedKey]: {
            ...defaultSourceMemberValues,
            MemberType: getMetadataTypeFromKey(encodedKey),
            MemberName: getMetadataNameFromKey(encodedKey),
            RevisionCounter: 2,
            lastRetrievedFromServer: 2,
            IsNameObsolete: false,
          },
        },
      } satisfies SetContentsInput;
      setContents(maxJson);

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember('Layout###Broker__c-v1.1 Broker Layout')).to.deep.equal({
        ...defaultSourceMemberValues,
        MemberName: 'Broker__c-v1.1 Broker Layout',
        RevisionCounter: 2,
        lastRetrievedFromServer: 2,
        MemberType: 'Layout',
        IsNameObsolete: false,
      });
    });

    it('will match/update decoded SourceMember keys on set', () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout###Broker__c-Broker Layout': {
            ...defaultSourceMemberValues,
            RevisionCounter: 1,
            lastRetrievedFromServer: 1,
            MemberType: 'Layout',
            IsNameObsolete: false,
            MemberName: getMetadataNameFromKey('Layout###Broker__c-Broker Layout'),
          },
          'Layout###Broker__c-v1.1 Broker Layout': {
            ...defaultSourceMemberValues,

            RevisionCounter: 2,
            lastRetrievedFromServer: 2,
            MemberType: 'Layout',
            IsNameObsolete: false,
            MemberName: getMetadataNameFromKey('Layout###Broker__c-v1.1 Broker Layout'),
          },
        },
      } satisfies SetContentsInput;
      setContents(maxJson);

      // @ts-ignore setMemberRevision is private
      remoteSourceTrackingService.setMemberRevision('Layout###Broker__c-v1%2E1 Broker Layout', {
        ...defaultSourceMemberValues,
        MemberName: getMetadataNameFromKey('Layout###Broker__c-v1.1 Broker Layout'),
        RevisionCounter: 3,
        lastRetrievedFromServer: 3,
        MemberType: 'Layout',
        IsNameObsolete: false,
      });

      // @ts-expect-error getSourceMembers is private
      expect(remoteSourceTrackingService.sourceMembers).to.deep.equal(
        new Map(
          Object.entries({
            'Layout###Broker__c-Broker Layout': {
              ...defaultSourceMemberValues,
              RevisionCounter: 1,
              lastRetrievedFromServer: 1,
              MemberType: 'Layout',
              IsNameObsolete: false,
              MemberName: 'Broker__c-Broker Layout',
            },
            'Layout###Broker__c-v1.1 Broker Layout': {
              ...defaultSourceMemberValues,
              MemberName: 'Broker__c-v1.1 Broker Layout',
              RevisionCounter: 3,
              lastRetrievedFromServer: 3,
              MemberType: 'Layout',
              IsNameObsolete: false,
            },
          })
        )
      );
    });

    it('should not throw for non-decodeable key missing from SourceMember map on get', () => {
      // trying to decode '%E0%A4%A' throws a URIError so getDecodedKeyIfSourceMembersHas()
      // should not throw when a non-decodeable key is encountered.
      const sourceMemberKey = 'Layout###Broker__c-%E0%A4%A';

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember(sourceMemberKey)).to.equal(undefined);
    });

    it('will match/update encoded SourceMember keys on set', () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout###Broker__c-Broker Layout': {
            ...defaultSourceMemberValues,
            MemberName: getMetadataNameFromKey('Layout###Broker__c-Broker Layout'),
            RevisionCounter: 1,
            lastRetrievedFromServer: 1,
            MemberType: 'Layout',
            IsNameObsolete: false,
          },
          'Layout###Broker__c-v1%2E1 Broker Layout': {
            ...defaultSourceMemberValues,
            MemberName: getMetadataNameFromKey('Layout###Broker__c-v1%2E1 Broker Layout'),
            RevisionCounter: 2,
            lastRetrievedFromServer: 2,
            MemberType: 'Layout',
            IsNameObsolete: false,
          },
        },
      } satisfies SetContentsInput;
      setContents(maxJson);

      // @ts-ignore setMemberRevision is private
      remoteSourceTrackingService.setMemberRevision('Layout###Broker__c-v1.1 Broker Layout', {
        ...defaultSourceMemberValues,
        MemberName: getMetadataNameFromKey('Layout###Broker__c-v1%2E1 Broker Layout'),
        RevisionCounter: 3,
        lastRetrievedFromServer: 3,
        MemberType: 'Layout',
        IsNameObsolete: false,
      });

      // @ts-expect-error getSourceMembers is private
      expect(remoteSourceTrackingService.sourceMembers).to.deep.equal(
        new Map(
          Object.entries({
            'Layout###Broker__c-Broker Layout': {
              ...defaultSourceMemberValues,
              MemberName: 'Broker__c-Broker Layout',
              RevisionCounter: 1,
              lastRetrievedFromServer: 1,
              MemberType: 'Layout',
              IsNameObsolete: false,
            },
            'Layout###Broker__c-v1%2E1 Broker Layout': {
              ...defaultSourceMemberValues,
              MemberName: 'Broker__c-v1.1 Broker Layout',
              RevisionCounter: 3,
              lastRetrievedFromServer: 3,
              MemberType: 'Layout',
              IsNameObsolete: false,
            },
          })
        )
      );
    });
  });

  describe('setServerMaxRevision', () => {
    it('should set the initial serverMaxRevisionCounter to zero during file creation', () => {
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.serverMaxRevisionCounter).to.equal(0);
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.sourceMembers).to.eql(new Map());
    });
  });

  describe('pollForSourceMembers', () => {
    const memberNames: RemoteSyncInput[] = ['MyClass1', 'MyClass2', 'MyClass3'].map((name) => ({
      type: 'ApexClass',
      fullName: name,
      filePath: 'foo',
      state: ComponentStatus.Changed,
    }));

    afterEach(() => {
      envVars.unset('SFDX_DISABLE_SOURCE_MEMBER_POLLING');
      envVars.unset('SF_DISABLE_SOURCE_MEMBER_POLLING');
      envVars.unset('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT');
      envVars.unset('SF_SOURCE_MEMBER_POLLING_TIMEOUT');
    });

    it('should sync SourceMembers when query results match', async () => {
      // @ts-ignore
      const queryStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom');
      // @ts-expect-error it's private
      remoteSourceTrackingService.serverMaxRevisionCounter = 9;

      queryStub.onFirstCall().resolves([]);
      const queryResult = [1, 2, 3].map((rev) => getSourceMember(rev));
      // @ts-ignore
      queryStub.onSecondCall().resolves(queryResult);

      // @ts-ignore
      const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

      // @ts-ignore
      await remoteSourceTrackingService.pollForSourceTracking(memberNames, 2);
      // this test changed from toolbelt because each server query now update the tracking files
      expect(
        trackSpy.calledTwice,
        `trackSourceMembers was not called twice.  it was called ${trackSpy.callCount} times`
      ).to.equal(true);
      expect(queryStub.called).to.equal(true);
    });
    it('should sync specific elements', async () => {
      expect(getContents()).to.deep.equal({
        serverMaxRevisionCounter: 0,
        sourceMembers: {},
      });
      const contents = {
        serverMaxRevisionCounter: 1,
        sourceMembers: {
          'Profile###my(awesome)profile': {
            ...defaultSourceMemberValues,
            MemberName: getMetadataNameFromKey('Profile###my(awesome)profile'),
            IsNewMember: false,
            IsNameObsolete: false,
            RevisionCounter: 1,
            lastRetrievedFromServer: undefined,
            MemberType: 'Profile',
          },
        },
      };
      setContents(contents);
      await remoteSourceTrackingService.syncSpecifiedElements([
        {
          fullName: 'my(awesome)profile',
          type: 'Profile',
          filePath: 'my%28awesome%29profile.profile-meta.xml',
          state: ComponentStatus.Changed,
        },
      ]);
      // lastRetrievedFromServer should be set to the RevisionCounter
      expect(getContents()).to.deep.equal({
        serverMaxRevisionCounter: 1,
        sourceMembers: {
          'Profile###my(awesome)profile': {
            ...defaultSourceMemberValues,
            MemberName: 'my(awesome)profile',
            IsNameObsolete: false,
            lastRetrievedFromServer: 1,
            MemberType: 'Profile',
            RevisionCounter: 1,
          },
        },
      });
    });
    it('should not poll when SFDX_DISABLE_SOURCE_MEMBER_POLLING=true', async () => {
      envVars.setString('SFDX_DISABLE_SOURCE_MEMBER_POLLING', 'true');

      reResolveEnvVars();
      const getBooleanSpy = $$.SANDBOX.spy(EnvVars.prototype, 'getBoolean');

      // @ts-ignore
      const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

      // @ts-ignore
      await remoteSourceTrackingService.pollForSourceTracking(memberNames, 2);
      expect(trackSpy.called).to.equal(false);
      expect(getBooleanSpy.calledOnce).to.equal(true);
    });
    it('should not poll when SF_DISABLE_SOURCE_MEMBER_POLLING=true', async () => {
      envVars.setString('SF_DISABLE_SOURCE_MEMBER_POLLING', 'true');
      reResolveEnvVars();
      const getBooleanSpy = $$.SANDBOX.spy(EnvVars.prototype, 'getBoolean');

      // @ts-ignore
      const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

      // @ts-ignore
      await remoteSourceTrackingService.pollForSourceTracking(memberNames, 2);
      expect(trackSpy.called).to.equal(false);
      expect(getBooleanSpy.calledOnce).to.equal(true);
    });

    describe('timeout handling', () => {
      const warns = new Set<string>();

      beforeEach(async () => {
        warns.clear();
        const { Lifecycle } = await import('@salesforce/core');
        const lc = Lifecycle.getInstance();
        lc.onWarning((w) => {
          warns.add(w);
          return Promise.resolve();
        });
      });

      it('should stop if the computed pollingTimeout is exceeded', async () => {
        // @ts-ignore
        const queryStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom').resolves([]);

        // @ts-ignore
        const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

        // @ts-ignore
        await remoteSourceTrackingService.pollForSourceTracking(memberNames);
        // changed from toolbelt because each query result goes to tracking
        expect(trackSpy.callCount).to.equal(6);
        expect(warns.size).to.be.greaterThan(0);
        const expectedMsg = 'Polling for 3 SourceMembers timed out after 6 attempts';
        expect(Array.from(warns).some((w) => w.includes(expectedMsg))).to.equal(true);
        expect(queryStub.called).to.equal(true);
      }).timeout(10_000);

      it('should stop if SFDX_SOURCE_MEMBER_POLLING_TIMEOUT is exceeded', async () => {
        envVars.setString('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT', '3');
        reResolveEnvVars();
        // @ts-ignore
        const queryStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom').resolves([]);

        // @ts-ignore
        const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

        // @ts-ignore
        await remoteSourceTrackingService.pollForSourceTracking(memberNames);
        expect(trackSpy.called).to.equal(true);

        expect(warns.size).to.be.greaterThan(0);
        const expectedMsg = 'Polling for 3 SourceMembers timed out after 3 attempts';
        expect(Array.from(warns).some((w) => w.includes(expectedMsg))).to.equal(true);
        expect(queryStub.called).to.equal(true);
      });
      it('should stop if SF_SOURCE_MEMBER_POLLING_TIMEOUT is exceeded', async () => {
        envVars.setString('SF_SOURCE_MEMBER_POLLING_TIMEOUT', '3');
        reResolveEnvVars();
        // @ts-ignore
        const queryStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom').resolves([]);

        // @ts-ignore
        const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

        // @ts-ignore
        await remoteSourceTrackingService.pollForSourceTracking(memberNames);
        expect(trackSpy.called).to.equal(true);

        expect(warns.size).to.be.greaterThan(0);
        const expectedMsg = 'Polling for 3 SourceMembers timed out after 3 attempts';
        expect(Array.from(warns).some((w) => w.includes(expectedMsg))).to.equal(true);
        expect(queryStub.called).to.equal(true);
      });
    });
  });

  describe('reset', () => {
    it('should reset source tracking state to be synced with the max RevisionCounter on the org', async () => {
      // Set initial test state of 5 apex classes not yet synced.
      setContents({
        serverMaxRevisionCounter: 5,
        sourceMembers: getMemberRevisionEntries(5),
      });
      // @ts-ignore
      const queryToSpy = $$.SANDBOX.spy(orgQueryMocks, 'querySourceMembersTo');
      const sourceMembers = [1, 2, 3, 4, 5, 6, 7].map((rev) => getSourceMember(rev));
      // @ts-ignore
      $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom').resolves(sourceMembers);

      await remoteSourceTrackingService.reset();

      expect(queryToSpy.called).to.equal(false);
      const contents = getContents();
      // @ts-expect-error it's private
      expect(remoteSourceTrackingService.serverMaxRevisionCounter).to.equal(7);
      const expectedMemberRevisions = getMemberRevisionEntries(7, true);
      expect(contents.sourceMembers).to.deep.equal(expectedMemberRevisions);
    });

    it('should reset source tracking state to be synced with the specified revision', async () => {
      // Set initial test state of 5 apex classes not yet synced.
      setContents({
        serverMaxRevisionCounter: 5,
        sourceMembers: getMemberRevisionEntries(5),
      });
      // @ts-ignore
      const queryFromSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'querySourceMembersFrom');
      const sourceMembers = [1, 2, 3].map((rev) => getSourceMember(rev));
      // @ts-ignore
      $$.SANDBOX.stub(orgQueryMocks, 'querySourceMembersTo').resolves(sourceMembers);

      await remoteSourceTrackingService.reset(3);

      expect(queryFromSpy.called).to.equal(false);
      const contents = getContents();
      expect(contents.serverMaxRevisionCounter).to.equal(3);
      const expectedMemberRevisions = getMemberRevisionEntries(3, true);
      expect(contents.sourceMembers).to.deep.equal(expectedMemberRevisions);
    });
  });

  describe('file location support', () => {
    it('should return the correct file location (base case)', () => {
      expect(remoteSourceTrackingService.filePath).to.include(`.sf${sep}`);
    });
  });
});

describe('upgrading undefined to v1 file', () => {
  it('returns new file version even if file is not versioned', () => {
    const oldFile = {
      serverMaxRevisionCounter: 0,
      sourceMembers: {},
    };
    expect(upgradeFileContents(oldFile).fileVersion).to.equal(1);
  });

  it('handles missing string-type fields', () => {
    const oldFile = {
      serverMaxRevisionCounter: 1,
      sourceMembers: {
        ApexClass__MyClass: {
          serverRevisionCounter: 1,
          lastRetrievedFromServer: 1,
          memberType: 'ApexClass',
          isNameObsolete: false,
        } satisfies MemberRevisionLegacy,
      },
    };
    expect(upgradeFileContents(oldFile).sourceMembers['ApexClass###MyClass']).to.deep.equal({
      MemberIdOrName: 'unknown',
      ChangedBy: 'unknown',
      lastRetrievedFromServer: 1,
      MemberType: 'ApexClass',
      IsNameObsolete: false,
      RevisionCounter: 1,
      MemberName: 'MyClass',
    } satisfies Omit<MemberRevision, 'IsNewMember'>);
  });

  it('handles null lastRetrievedFromServer', () => {
    const oldFile = {
      serverMaxRevisionCounter: 1,
      sourceMembers: {
        ApexClass__MyClass: {
          serverRevisionCounter: 1,
          lastRetrievedFromServer: null,
          memberType: 'ApexClass',
          isNameObsolete: false,
        } satisfies MemberRevisionLegacy,
      },
    };
    expect(upgradeFileContents(oldFile).sourceMembers['ApexClass###MyClass']).to.have.property(
      'lastRetrievedFromServer',
      undefined
    );
  });
  it('memberType and key are always decoded', () => {
    const encodedKey = 'Layout__Broker__c-v1%2E1 Broker Layout';

    const oldFile = {
      serverMaxRevisionCounter: 1,
      sourceMembers: {
        [encodedKey]: {
          serverRevisionCounter: 1,
          lastRetrievedFromServer: null,
          memberType: 'Layout',
          isNameObsolete: false,
        } satisfies MemberRevisionLegacy,
      },
    };
    expect(upgradeFileContents(oldFile).sourceMembers['Layout###Broker__c-v1.1 Broker Layout']).to.have.property(
      'MemberName',
      'Broker__c-v1.1 Broker Layout'
    );
  });
});
