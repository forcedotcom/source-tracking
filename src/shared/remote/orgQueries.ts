/*
 * Copyright 2025, Salesforce, Inc.
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
import { Connection, envVars as env, SfError, trimTo15 } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { PinoLogger } from './remoteSourceTrackingService.js';
import { SOURCE_MEMBER_FIELDS, SourceMember } from './types.js';

export const calculateTimeout =
  (logger: PinoLogger) =>
  (memberCount: number): Duration => {
    const overriddenTimeout = env.getNumber('SF_SOURCE_MEMBER_POLLING_TIMEOUT', 0);
    if (overriddenTimeout > 0) {
      logger.debug(`Overriding SourceMember polling timeout to ${overriddenTimeout}`);
      return Duration.seconds(overriddenTimeout);
    }

    // Calculate a polling timeout for SourceMembers based on the number of
    // member names being polled plus a buffer of 5 seconds.  This will
    // wait 50s for each 1000 components, plus 5s.
    const pollingTimeout = Math.ceil(memberCount * 0.05) + 5;
    logger.debug(`Computed SourceMember polling timeout of ${pollingTimeout}s`);
    return Duration.seconds(pollingTimeout);
  };
/** exported only for spy/mock  */

export const querySourceMembersTo = async (conn: Connection, toRevision: number): Promise<SourceMember[]> => {
  const query = `SELECT ${SOURCE_MEMBER_FIELDS.join(', ')} FROM SourceMember WHERE RevisionCounter <= ${toRevision}`;
  return queryFn(conn, query);
};

export const querySourceMembersFrom = async ({
  conn,
  fromRevision,
  queryCache,
  userQueryCache,
  logger,
}: {
  conn: Connection;
  fromRevision: number;
  /** optional cache, used if present.  Side effect: cache will be mutated */
  queryCache?: Map<number, SourceMember[]>;
  /** optional cache, used if present.  Side effect: cache will be mutated */
  userQueryCache?: Map<string, string>;
  /** if you don't pass in a logger, you get no log output */
  logger?: PinoLogger;
}): Promise<SourceMember[]> => {
  if (queryCache) {
    // Check cache first and return if found.
    const cachedQueryResult = queryCache.get(fromRevision);
    if (cachedQueryResult) {
      logger?.debug(`Using cache for SourceMember query for revision ${fromRevision}`);
      return cachedQueryResult;
    }
  }

  // because `serverMaxRevisionCounter` is always updated, we need to select > to catch the most recent change
  const query = `SELECT ${SOURCE_MEMBER_FIELDS.join(', ')} FROM SourceMember WHERE RevisionCounter > ${fromRevision}`;
  logger?.debug(`Query: ${query}`);

  const queryResult = await queryFn(conn, query);
  if (userQueryCache) {
    await updateCacheWithUnknownUsers(conn, queryResult, userQueryCache);
  }
  const queryResultWithResolvedUsers = queryResult.map((member) => ({
    ...member,
    ChangedBy: userQueryCache?.get(member.ChangedBy) ?? member.ChangedBy,
  }));
  queryCache?.set(fromRevision, queryResultWithResolvedUsers);

  return queryResultWithResolvedUsers;
};

const queryFn = async (conn: Connection, query: string): Promise<SourceMember[]> => {
  try {
    return (await conn.tooling.query<SourceMember>(query, { autoFetch: true, maxFetch: 50_000 })).records.map(
      sourceMemberCorrections
    );
  } catch (error) {
    throw SfError.wrap(error);
  }
};

/** A series of workarounds for server-side bugs.  Each bug should be filed against a team, with a WI, so we know when these are fixed and can be removed */
const sourceMemberCorrections = (sourceMember: SourceMember): SourceMember => {
  if (sourceMember.MemberType === 'QuickActionDefinition') {
    return { ...sourceMember, MemberType: 'QuickAction' }; // W-15837125
  }
  return sourceMember;
};

const updateCacheWithUnknownUsers = async (
  conn: Connection,
  queryResult: SourceMember[],
  userCache: Map<string, string>
): Promise<void> => {
  const unknownUsers = new Set<string>(queryResult.map((member) => member.ChangedBy).filter((u) => !userCache.has(u)));
  if (unknownUsers.size > 0) {
    const userQuery = `SELECT Id, Name FROM User WHERE Id IN ('${Array.from(unknownUsers).join("','")}')`;
    (await conn.query<{ Id: string; Name: string }>(userQuery, { autoFetch: true, maxFetch: 50_000 })).records.map(
      (u) => userCache.set(trimTo15(u.Id), u.Name)
    );
  }
};
