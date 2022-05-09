/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
/* eslint-disable @typescript-eslint/await-thenable */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable camelcase */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { sep } from 'path';
import { MockTestOrgData, instantiateContext, stubContext, restoreContext } from '@salesforce/core/lib/testSetup';
import { Messages, Org } from '@salesforce/core';
import * as kit from '@salesforce/kit';
import { expect } from 'chai';
import { SinonStub } from 'sinon';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { RemoteSourceTrackingService } from '../../src/shared/remoteSourceTrackingService';
import { RemoteSyncInput, SourceMember, MemberRevision } from '../../src/shared/types';
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
  const orgId = '00D456789012345';
  const $$ = instantiateContext();
  let remoteSourceTrackingService: RemoteSourceTrackingService;

  afterEach(() => {
    restoreContext($$);
  });

  beforeEach(async () => {
    stubContext($$);
    const orgData = new MockTestOrgData();
    orgData.username = username;
    orgData.orgId = orgId;

    $$.setConfigStubContents('GlobalInfo', {
      contents: {
        orgs: {
          [username]: await orgData.getConfig(),
        },
      },
    });
    const org = await Org.create({ aliasOrUsername: username });
    $$.SANDBOX.stub(org.getConnection().tooling, 'query').resolves({ records: [], done: true, totalSize: 0 });
    remoteSourceTrackingService = await RemoteSourceTrackingService.create({
      org,
      projectPath: await $$.localPathRetriever($$.id),
      useSfdxTrackingFiles: false,
    });
  });

  describe('getServerMaxRevision', () => {
    it('should return 0 if file does not exist', async () => {
      // @ts-ignore
      const max = await remoteSourceTrackingService.getServerMaxRevision();
      expect(max).to.equal(0);
    });
  });

  describe('init', () => {
    it('should set initial state of contents', async () => {
      $$.SANDBOX.stub(remoteSourceTrackingService, 'getContents').returns({
        serverMaxRevisionCounter: null,
        sourceMembers: null,
      }) as SinonStub;
      // @ts-ignore
      const queryMembersFromSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'querySourceMembersFrom');
      await remoteSourceTrackingService.init();
      // @ts-ignore
      expect(remoteSourceTrackingService.getServerMaxRevision()).to.equal(0);
      // @ts-ignore
      expect(remoteSourceTrackingService.getSourceMembers()).to.deep.equal({});
      expect(queryMembersFromSpy.called).to.equal(true);
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
          },
          ApexClass__abc: {
            memberType: 'ApexClass',
            serverRevisionCounter: 2,
            lastRetrievedFromServer: 2,
          },
        },
      };
      await remoteSourceTrackingService.setContentsFromObject(maxJson);

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
      expect(remoteSourceTrackingService.getTrackedElement('ApexClass__test1__c')).to.deep.equal({
        name: 'test1__c',
        type: 'ApexClass',
        deleted: false,
      });

      // @ts-ignore getSourceMember is private
      expect(remoteSourceTrackingService.getSourceMember('ApexClass__test2__c')).to.deep.equal({
        serverRevisionCounter: 2,
        lastRetrievedFromServer: null,
        memberType: 'ApexClass',
        isNameObsolete: true,
      });
      expect(remoteSourceTrackingService.getTrackedElement('ApexClass__test2__c')).to.deep.equal({
        name: 'test2__c',
        type: 'ApexClass',
        deleted: true,
      });
    });
  });

  describe('setServerMaxRevision', () => {
    it('should set the initial serverMaxRevisionCounter to zero during file creation', async () => {
      await remoteSourceTrackingService.init();
      const contents = await remoteSourceTrackingService.getContents();
      expect(contents.serverMaxRevisionCounter).to.equal(0);
      expect(contents.sourceMembers).to.eql({});
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
      // @ts-ignore
      const getServerMaxRevisionStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'getServerMaxRevision');
      const maxRev = 9;
      getServerMaxRevisionStub.returns(maxRev);

      // @ts-ignore
      queryStub.onFirstCall().resolves([]);
      const queryResult = [1, 2, 3].map((rev) => getSourceMember(rev));
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
      expect(
        getServerMaxRevisionStub.calledOnce,
        `getServerMaxRevisionStub was not called once.  it was called ${queryStub.callCount} times`
      ).to.equal(true);
    });
    it('should not poll when SFDX_DISABLE_SOURCE_MEMBER_POLLING=true', async () => {
      const getBooleanStub = $$.SANDBOX.stub(kit.env, 'getBoolean').callsFake(() => true);
      // @ts-ignore
      const getServerMaxRevisionStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'getServerMaxRevision');

      // @ts-ignore
      const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

      // @ts-ignore
      await remoteSourceTrackingService.pollForSourceTracking(memberNames, 2);
      expect(trackSpy.called).to.equal(false);
      expect(getBooleanStub.calledOnce).to.equal(true);
      expect(getServerMaxRevisionStub.notCalled).to.equal(true);
    });

    describe('timeout handling', () => {
      it('should stop if the computed pollingTimeout is exceeded', async () => {
        // @ts-ignore
        const queryStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom').resolves([]);
        const warnSpy = $$.SANDBOX.spy($$.TEST_LOGGER, 'warn');
        // @ts-ignore
        const getServerMaxRevisionStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'getServerMaxRevision');
        const maxRev = 9;
        getServerMaxRevisionStub.returns(maxRev);

        // @ts-ignore
        const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

        // @ts-ignore
        await remoteSourceTrackingService.pollForSourceTracking(memberNames);
        // changed from toolbelt because each query result goes to tracking
        expect(trackSpy.callCount).to.equal(6);
        expect(warnSpy.called).to.equal(true);
        const expectedMsg = 'Polling for SourceMembers timed out after 6 attempts';
        expect(warnSpy.calledWithMatch(expectedMsg)).to.equal(true);
        expect(queryStub.called).to.equal(true);
        expect(getServerMaxRevisionStub.calledOnce).to.equal(true);
      }).timeout(10000);

      it('should stop if SFDX_SOURCE_MEMBER_POLLING_TIMEOUT is exceeded', async () => {
        // @ts-ignore
        $$.SANDBOX.stub(kit.env, 'getString').callsFake(() => '3');
        // @ts-ignore
        const queryStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom').resolves([]);
        const warnSpy = $$.SANDBOX.spy($$.TEST_LOGGER, 'warn');
        // @ts-ignore
        const getServerMaxRevisionStub = $$.SANDBOX.stub(remoteSourceTrackingService, 'getServerMaxRevision');
        const maxRev = 9;
        getServerMaxRevisionStub.returns(maxRev);

        // @ts-ignore
        const trackSpy = $$.SANDBOX.stub(remoteSourceTrackingService, 'trackSourceMembers');

        // @ts-ignore
        await remoteSourceTrackingService.pollForSourceTracking(memberNames);
        expect(trackSpy.called).to.equal(true);

        expect(warnSpy.called).to.equal(true);
        const expectedMsg = 'Polling for SourceMembers timed out after 3 attempts';
        expect(warnSpy.calledWithMatch(expectedMsg)).to.equal(true);
        expect(warnSpy.calledOnce).to.equal(true);
        expect(queryStub.called).to.equal(true);
        expect(getServerMaxRevisionStub.calledOnce).to.equal(true);
      });
    });
  });

  describe('reset', () => {
    it('should reset source tracking state to be synced with the max RevisionCounter on the org', async () => {
      // Set initial test state of 5 apex classes not yet synced.
      remoteSourceTrackingService['contents'] = {
        serverMaxRevisionCounter: 5,
        sourceMembers: getMemberRevisionEntries(5),
      };

      // @ts-ignore
      const setMaxSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'setServerMaxRevision');
      // @ts-ignore
      const initMembersSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'initSourceMembers');
      // @ts-ignore
      const queryToSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'querySourceMembersTo');
      const sourceMembers = [1, 2, 3, 4, 5, 6, 7].map((rev) => getSourceMember(rev));
      // @ts-ignore
      $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersFrom').resolves(sourceMembers);

      await remoteSourceTrackingService.reset();

      expect(setMaxSpy.calledTwice).to.equal(true);
      expect(setMaxSpy.firstCall.args[0]).to.equal(0);
      expect(setMaxSpy.secondCall.args[0]).to.equal(7);
      expect(initMembersSpy.called).to.equal(true);
      expect(queryToSpy.called).to.equal(false);
      const contents = remoteSourceTrackingService.getContents();
      expect(contents.serverMaxRevisionCounter).to.equal(7);
      const expectedMemberRevisions = getMemberRevisionEntries(7, true);
      expect(contents.sourceMembers).to.deep.equal(expectedMemberRevisions);
    });

    it('should reset source tracking state to be synced with the specified revision', async () => {
      // Set initial test state of 5 apex classes not yet synced.
      remoteSourceTrackingService['contents'] = {
        serverMaxRevisionCounter: 5,
        sourceMembers: getMemberRevisionEntries(5),
      };

      // @ts-ignore
      const setMaxSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'setServerMaxRevision');
      // @ts-ignore
      const initMembersSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'initSourceMembers');
      // @ts-ignore
      const queryFromSpy = $$.SANDBOX.spy(remoteSourceTrackingService, 'querySourceMembersFrom');
      const sourceMembers = [1, 2, 3].map((rev) => getSourceMember(rev));
      // @ts-ignore
      $$.SANDBOX.stub(remoteSourceTrackingService, 'querySourceMembersTo').resolves(sourceMembers);

      await remoteSourceTrackingService.reset(3);

      expect(setMaxSpy.calledTwice).to.equal(true);
      expect(setMaxSpy.firstCall.args[0]).to.equal(0);
      expect(setMaxSpy.secondCall.args[0]).to.equal(3);
      expect(initMembersSpy.called).to.equal(true);
      expect(queryFromSpy.called).to.equal(false);
      const contents = remoteSourceTrackingService.getContents();
      expect(contents.serverMaxRevisionCounter).to.equal(3);
      const expectedMemberRevisions = getMemberRevisionEntries(3, true);
      expect(contents.sourceMembers).to.deep.equal(expectedMemberRevisions);
    });
  });

  describe('file location support', () => {
    it('should return the correct file location (base case)', () => {
      const fileLocation = remoteSourceTrackingService.getPath();
      expect(fileLocation).to.include(`.sf${sep}`);
    });
    it('should return the correct file location (sfdx legacy case)', async () => {
      // redo the context
      restoreContext($$);
      stubContext($$);
      const orgData = new MockTestOrgData();
      orgData.username = username;
      orgData.orgId = orgId;

      $$.setConfigStubContents('GlobalInfo', {
        contents: {
          orgs: {
            [username]: await orgData.getConfig(),
          },
        },
      });
      const org = await Org.create({ aliasOrUsername: username });
      $$.SANDBOX.stub(org.getConnection().tooling, 'query').resolves({ records: [], done: true, totalSize: 0 });
      remoteSourceTrackingService = await RemoteSourceTrackingService.create({
        org,
        projectPath: await $$.localPathRetriever($$.id),
        useSfdxTrackingFiles: true,
      });

      const fileLocation = remoteSourceTrackingService.getPath();
      expect(fileLocation).to.include(`.sfdx${sep}`);
    });
  });
});
