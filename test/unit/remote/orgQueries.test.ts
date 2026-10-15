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

import { Logger, envVars } from '@salesforce/core';
import type { Connection } from '@salesforce/core';
import { expect } from 'chai';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import {
  calculateTimeout,
  makeUserNameCache,
  querySourceMembersFrom,
  querySourceMembersTo,
} from '../../../src/shared/remote/orgQueries.js';
import type { SourceMember } from '../../../src/shared/remote/types.js';

const reResolveEnvVars = (): void => {
  /* eslint-disable @typescript-eslint/no-unsafe-call */
  // @ts-expect-error test setup forces EnvVars to resolve updated process values
  envVars.resolve();
  /* eslint-enable @typescript-eslint/no-unsafe-call */
};

const member: SourceMember = {
  MemberType: 'QuickActionDefinition',
  MemberName: 'MyAction',
  IsNameObsolete: false,
  IsNewMember: true,
  RevisionCounter: 7,
  MemberIdOrName: 'MyAction',
  ChangedBy: '005000000000001',
  LastModifiedDate: '2026-01-01T00:00:00.000Z',
};

describe('remote SourceMember queries', () => {
  it('resolves ChangedBy names and corrects known server member types', async () => {
    const queries: string[] = [];
    const secondMember = { ...member, MemberName: 'AnotherAction', ChangedBy: '005000000000002' };
    const conn = {
      tooling: {
        query: (query: string) => {
          queries.push(query);
          return Promise.resolve({ records: [member, secondMember], done: true, totalSize: 2 });
        },
      },
      query: (query: string) => {
        queries.push(query);
        return Promise.resolve({
          records: [
            { Id: '005000000000001AAA', Name: 'Ada Lovelace' },
            { Id: '005000000000002AAA', Name: 'Grace Hopper' },
          ],
          done: true,
          totalSize: 2,
        });
      },
    } as unknown as Connection;
    const userNameCache = await Effect.runPromise(makeUserNameCache(conn));

    const queryOptions = { conn, fromRevision: 6, userNameCache };
    const results = await Effect.runPromise(querySourceMembersFrom(queryOptions));
    const repeatedResults = await Effect.runPromise(querySourceMembersFrom(queryOptions));

    expect(queries.filter((query) => query.includes('FROM SourceMember WHERE RevisionCounter > 6'))).to.have.length(2);
    expect(queries.filter((query) => query.startsWith('SELECT Id, Name'))).to.deep.equal([
      "SELECT Id, Name FROM User WHERE Id IN ('005000000000001','005000000000002')",
    ]);
    expect(results).to.deep.equal([
      {
        ...member,
        MemberType: 'QuickAction',
        ChangedBy: 'Ada Lovelace',
      },
      {
        ...secondMember,
        MemberType: 'QuickAction',
        ChangedBy: 'Grace Hopper',
      },
    ]);
    expect(repeatedResults).to.deep.equal(results);
  });

  it('queries SourceMembers through the requested revision', async () => {
    let query = '';
    const conn = {
      tooling: {
        query: (value: string) => {
          query = value;
          return Promise.resolve({ records: [member], done: true, totalSize: 1 });
        },
      },
    } as unknown as Connection;

    const results = await Effect.runPromise(querySourceMembersTo(conn, 9));

    expect(query).to.include('FROM SourceMember WHERE RevisionCounter <= 9');
    expect(results[0].MemberType).to.equal('QuickAction');
  });
});

describe('calculateTimeout', () => {
  const logger = new Logger({ useMemoryLogger: true, name: 'test' }).getRawLogger();
  const functionUnderTest = calculateTimeout(logger);

  afterEach(() => {
    envVars.unset('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT');
    envVars.unset('SF_SOURCE_MEMBER_POLLING_TIMEOUT');
  });

  it('defaults to five seconds with no members', () => {
    expect(Duration.toSeconds(functionUnderTest(0))).to.equal(5);
  });

  it('allocates fifty seconds per thousand members plus five seconds', () => {
    expect(Duration.toSeconds(functionUnderTest(10_000))).to.equal(505);
  });

  it('uses the environment override', () => {
    envVars.setString('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT', '60');
    reResolveEnvVars();
    expect(Duration.toSeconds(functionUnderTest(10_000))).to.equal(60);
  });

  it('ignores a zero environment override', () => {
    envVars.setString('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT', '0');
    reResolveEnvVars();
    expect(Duration.toSeconds(functionUnderTest(10_000))).to.equal(505);
  });
});
