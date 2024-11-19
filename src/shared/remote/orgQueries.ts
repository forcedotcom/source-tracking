/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Connection, envVars as env, SfError, trimTo15 } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { PinoLogger } from './remoteSourceTrackingService';
import { SOURCE_MEMBER_FIELDS, SourceMember } from './types';

export const updateCacheWithUnknownUsers = async (
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

export const queryFn = async (conn: Connection, query: string): Promise<SourceMember[]> => {
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

export const mockOrgQueries = {
  querySourceMembersTo,
};
