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
import { envVars, Logger, Messages, Org } from '@salesforce/core';
// eslint-disable-next-line no-restricted-imports
import { expect } from 'chai';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { RemoteSourceTrackingService, calculateTimeout, Contents } from '../../src/shared/remoteSourceTrackingService';
import { RemoteSyncInput, SourceMember, MemberRevision } from '../../src/shared/types';
import * as mocks from '../../src/shared/remoteSourceTrackingService';

Messages.importMessagesDirectory(__dirname);

const getSourceMember = (revision: number, deleted = false): SourceMember => ({
  RevisionCounter: revision,
  MemberType: 'ApexClass',
  MemberName: `MyClass${revision}`,
  IsNameObsolete: deleted,
});

const getMemberRevisionEntries = (revision: number, synced = false): { [key: string]: MemberRevision } => {
  const sourceMemberEntries = {} as { [key: string]: MemberRevision };
  for (let i = 1; i <= revision; i++) {
    sourceMemberEntries[`ApexClass__MyClass${i}`] = {
      serverRevisionCounter: i,
      lastRetrievedFromServer: synced ? i : null,
      memberType: 'ApexClass',
      isNameObsolete: false,
    };
  }
  return sourceMemberEntries;
};

describe('remoteSourceTrackingService', () => {
  const username = 'foo@bar.com';
  let orgId: string;
  const $$ = instantiateContext();
  let remoteSourceTrackingService: RemoteSourceTrackingService;

  /** a shared "cheater" method to do illegal operations for test setup purposes */
  const setContents = (contents: {
    serverMaxRevisionCounter: number;
    sourceMembers: { [key: string]: MemberRevision };
  }): void => {
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
      const queryMembersFromSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'querySourceMembersFrom');
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
      const fileContents = JSON.parse(await readFile(remoteSourceTrackingService.filePath, 'utf8')) as Contents;
      expect(fileContents.serverMaxRevisionCounter).to.equal(0);
      expect(fileContents.sourceMembers).to.deep.equal({});
    });

    it('should set initial state of contents when a file exists', async () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout__Broker__c-Broker Layout': {
            serverRevisionCounter: 1,
            lastRetrievedFromServer: 1,
            memberType: 'Layout',
            isNameObsolete: false,
          },
          'Layout__Broker__c-v1.1 Broker Layout': {
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 2,
            memberType: 'Layout',
            isNameObsolete: false,
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
          CustomObject__test__c: {
            memberType: 'CustomObject',
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 3,
            isNameObsolete: false,
          },
          ApexClass__abc: {
            memberType: 'ApexClass',
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 2,
            isNameObsolete: false,
          },
        },
      };
      setContents(maxJson);
      const changes = await remoteSourceTrackingService.retrieveUpdates();
      expect(changes.length).to.equal(1);
      expect(changes[0].name).to.equal('test__c');
      expect(changes[0].type).to.equal('CustomObject');
    });

    it('will upsert SourceMembers objects correctly', async () => {
      const sm1 = {
        MemberType: 'ApexClass',
        MemberName: 'test1__c',
        IsNameObsolete: false,
        RevisionCounter: 1,
      };
      const sm2 = {
        MemberType: 'ApexClass',
        MemberName: 'test2__c',
        IsNameObsolete: true,
        RevisionCounter: 2,
      };
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
      expect(remoteSourceTrackingService.getSourceMember('ApexClass__test1__c')).to.deep.equal({
        serverRevisionCounter: 1,
        lastRetrievedFromServer: null,
        memberType: 'ApexClass',
        isNameObsolete: false,
      });

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember('ApexClass__test2__c')).to.deep.equal({
        serverRevisionCounter: 2,
        lastRetrievedFromServer: null,
        memberType: 'ApexClass',
        isNameObsolete: true,
      });
    });

    it('will match decoded SourceMember keys on get', () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout__Broker__c-Broker Layout': {
            serverRevisionCounter: 1,
            lastRetrievedFromServer: 1,
            memberType: 'Layout',
            isNameObsolete: false,
          },
          'Layout__Broker__c-v1.1 Broker Layout': {
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 2,
            memberType: 'Layout',
            isNameObsolete: false,
          },
        },
      };
      setContents(maxJson);

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember('Layout__Broker__c-v1%2E1 Broker Layout')).to.deep.equal({
        serverRevisionCounter: 2,
        lastRetrievedFromServer: 2,
        memberType: 'Layout',
        isNameObsolete: false,
      });
    });

    it('will match encoded SourceMember keys on get', () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout__Broker__c-Broker Layout': {
            serverRevisionCounter: 1,
            lastRetrievedFromServer: 1,
            memberType: 'Layout',
            isNameObsolete: false,
          },
          'Layout__Broker__c-v1%2E1 Broker Layout': {
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 2,
            memberType: 'Layout',
            isNameObsolete: false,
          },
        },
      };
      setContents(maxJson);

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember('Layout__Broker__c-v1.1 Broker Layout')).to.deep.equal({
        serverRevisionCounter: 2,
        lastRetrievedFromServer: 2,
        memberType: 'Layout',
        isNameObsolete: false,
      });
    });

    it('will match/update decoded SourceMember keys on set', () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout__Broker__c-Broker Layout': {
            serverRevisionCounter: 1,
            lastRetrievedFromServer: 1,
            memberType: 'Layout',
            isNameObsolete: false,
          },
          'Layout__Broker__c-v1.1 Broker Layout': {
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 2,
            memberType: 'Layout',
            isNameObsolete: false,
          },
        },
      };
      setContents(maxJson);

      // @ts-ignore setMemberRevision is private
      remoteSourceTrackingService.setMemberRevision('Layout__Broker__c-v1%2E1 Broker Layout', {
        serverRevisionCounter: 3,
        lastRetrievedFromServer: 3,
        memberType: 'Layout',
        isNameObsolete: false,
      });

      // @ts-expect-error getSourceMembers is private
      expect(remoteSourceTrackingService.sourceMembers).to.deep.equal(
        new Map(
          Object.entries({
            'Layout__Broker__c-Broker Layout': {
              serverRevisionCounter: 1,
              lastRetrievedFromServer: 1,
              memberType: 'Layout',
              isNameObsolete: false,
            },
            'Layout__Broker__c-v1.1 Broker Layout': {
              serverRevisionCounter: 3,
              lastRetrievedFromServer: 3,
              memberType: 'Layout',
              isNameObsolete: false,
            },
          })
        )
      );
    });

    it('should not throw for non-decodeable key missing from SourceMember map on get', () => {
      // trying to decode '%E0%A4%A' throws a URIError so getDecodedKeyIfSourceMembersHas()
      // should not throw when a non-decodeable key is encountered.
      const sourceMemberKey = 'Layout__Broker__c-%E0%A4%A';

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember(sourceMemberKey)).to.equal(undefined);
    });

    it('will match/update encoded SourceMember keys on set', () => {
      const maxJson = {
        serverMaxRevisionCounter: 2,
        sourceMembers: {
          'Layout__Broker__c-Broker Layout': {
            serverRevisionCounter: 1,
            lastRetrievedFromServer: 1,
            memberType: 'Layout',
            isNameObsolete: false,
          },
          'Layout__Broker__c-v1%2E1 Broker Layout': {
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 2,
            memberType: 'Layout',
            isNameObsolete: false,
          },
        },
      };
      setContents(maxJson);

      // @ts-ignore setMemberRevision is private
      remoteSourceTrackingService.setMemberRevision('Layout__Broker__c-v1.1 Broker Layout', {
        serverRevisionCounter: 3,
        lastRetrievedFromServer: 3,
        memberType: 'Layout',
        isNameObsolete: false,
      });

      // @ts-expect-error getSourceMembers is private
      expect(remoteSourceTrackingService.sourceMembers).to.deep.equal(
        new Map(
          Object.entries({
            'Layout__Broker__c-Broker Layout': {
              serverRevisionCounter: 1,
              lastRetrievedFromServer: 1,
              memberType: 'Layout',
              isNameObsolete: false,
            },
            'Layout__Broker__c-v1%2E1 Broker Layout': {
              serverRevisionCounter: 3,
              lastRetrievedFromServer: 3,
              memberType: 'Layout',
              isNameObsolete: false,
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
      setContents({
        serverMaxRevisionCounter: 1,
        sourceMembers: {
          'Profile__my(awesome)profile': {
            isNameObsolete: false,
            serverRevisionCounter: 1,
            lastRetrievedFromServer: null,
            memberType: 'Profile',
          },
        },
      });
      await remoteSourceTrackingService.syncSpecifiedElements([
        {
          fullName: 'my(awesome)profile',
          type: 'Profile',
          filePath: 'my%28awesome%29profile.profile-meta.xml',
          state: ComponentStatus.Changed,
        },
      ]);
      // lastRetrievedFromServer should be set to the serverRevisionCounter
      expect(getContents()).to.deep.equal({
        serverMaxRevisionCounter: 1,
        sourceMembers: {
          'Profile__my(awesome)profile': {
            isNameObsolete: false,
            lastRetrievedFromServer: 1,
            memberType: 'Profile',
            serverRevisionCounter: 1,
          },
        },
      });
    });
    it('should not poll when SFDX_DISABLE_SOURCE_MEMBER_POLLING=true', async () => {
      const getBooleanStub = $$.SANDBOX.stub(envVars, 'getBoolean').callsFake(() => true);

      // @ts-ignore
      const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

      // @ts-ignore
      await remoteSourceTrackingService.pollForSourceTracking(memberNames, 2);
      expect(trackSpy.called).to.equal(false);
      expect(getBooleanStub.calledOnce).to.equal(true);
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
        // @ts-ignore
        $$.SANDBOX.stub(envVars, 'getString').callsFake(() => '3');
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
      const queryToSpy = $$.SANDBOX.spy(mocks, 'querySourceMembersTo');
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
      $$.SANDBOX.stub(mocks, 'querySourceMembersTo').resolves(sourceMembers);

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

describe('calculateTimeout', () => {
  const logger = new Logger({ useMemoryLogger: true, name: 'test' }).getRawLogger();
  const functionUnderTest = calculateTimeout(logger);
  afterEach(() => {
    delete process.env.SFDX_SOURCE_MEMBER_POLLING_TIMEOUT;
  });
  it('0 members => 5 sec', () => {
    expect(functionUnderTest(0).seconds).to.equal(5);
  });
  it('10000 members => 505 sec', () => {
    expect(functionUnderTest(10_000).seconds).to.equal(505);
  });
  it('override 60 in env', () => {
    process.env.SFDX_SOURCE_MEMBER_POLLING_TIMEOUT = '60';
    expect(functionUnderTest(10_000).seconds).to.equal(60);
  });
  it('override 0 in env has no effect', () => {
    process.env.SFDX_SOURCE_MEMBER_POLLING_TIMEOUT = '0';
    expect(functionUnderTest(10_000).seconds).to.equal(505);
  });
});
