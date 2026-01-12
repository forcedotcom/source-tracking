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
/* eslint-disable camelcase */
import fs from 'node:fs';
import { expect } from 'chai';
import { parseJsonMap } from '@salesforce/kit';
import { getFilePath, upgradeFileContents, writeTrackingFile } from '../../../src/shared/remote/fileOperations';
import { ContentsV0, ContentsV1, MemberRevision, MemberRevisionLegacy } from '../../../src/shared/remote/types';

describe('writing file version based on env', () => {
  const fakeOrgId = '00DFakeFakeFakeFak';
  const filePath = getFilePath(fakeOrgId);
  const fakeSourceMembers = new Map<string, MemberRevision>([
    [
      'ApexClass###MyClass',
      {
        MemberIdOrName: 'unknown',
        ChangedBy: 'unknown',
        lastRetrievedFromServer: 1,
        MemberType: 'ApexClass',
        IsNameObsolete: false,
        RevisionCounter: 1,
        MemberName: 'MyClass',
        IsNewMember: false,
        LastModifiedDate: new Date().toJSON(),
      } satisfies MemberRevision,
    ],
  ]);

  afterEach(async () => {
    delete process.env.SF_SOURCE_TRACKING_FILE_VERSION;
    await fs.promises.unlink(filePath);
  });
  it('writes v1 fileVersion when env is set to 1', async () => {
    process.env.SF_SOURCE_TRACKING_FILE_VERSION = '1';
    await writeTrackingFile({ filePath, maxCounter: 1, members: fakeSourceMembers });
    const contents = await fs.promises.readFile(filePath, 'utf8');
    const parsedContents = parseJsonMap<ContentsV1>(contents, filePath);
    expect(parsedContents.fileVersion).to.equal(1);
    expect(parsedContents.serverMaxRevisionCounter).to.equal(1);
  });

  describe('v0', () => {
    const expectedKeys = ['memberType', 'serverRevisionCounter', 'lastRetrievedFromServer', 'isNameObsolete'];
    it('writes v0 fileVersion when env is set to 0', async () => {
      process.env.SF_SOURCE_TRACKING_FILE_VERSION = '0';
      await writeTrackingFile({ filePath, maxCounter: 1, members: fakeSourceMembers });
      const contents = await fs.promises.readFile(filePath, 'utf8');
      const parsedContents = parseJsonMap<ContentsV0>(contents, filePath);
      expect(parsedContents.fileVersion).to.equal(0);
      expect(parsedContents.serverMaxRevisionCounter).to.equal(1);
      expect(parsedContents.sourceMembers).to.have.key('ApexClass__MyClass');
      expect(parsedContents.sourceMembers['ApexClass__MyClass']).to.have.all.keys(expectedKeys);
    });

    it('writes v0 fileVersion when env is unset', async () => {
      await writeTrackingFile({ filePath, maxCounter: 1, members: fakeSourceMembers });
      const contents = await fs.promises.readFile(filePath, 'utf8');
      const parsedContents = parseJsonMap<ContentsV0>(contents, filePath);
      expect(parsedContents.fileVersion).to.equal(0);
      expect(parsedContents.serverMaxRevisionCounter).to.equal(1);
      expect(parsedContents.sourceMembers).to.have.key('ApexClass__MyClass');
      expect(parsedContents.sourceMembers['ApexClass__MyClass']).to.have.all.keys(expectedKeys);
    });
  });
});

describe('upgrading undefined file version to v1 file', () => {
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
      LastModifiedDate: 'unknown',
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
