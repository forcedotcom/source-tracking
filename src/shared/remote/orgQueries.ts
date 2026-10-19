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

import { Connection, SfError, trimTo15 } from '@salesforce/core';
import * as Cache from 'effect/Cache';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Request from 'effect/Request';
import * as RequestResolver from 'effect/RequestResolver';
import { PinoLogger, SOURCE_MEMBER_FIELDS, SourceMember } from './types.js';

const MAX_FETCH = 50_000;

export type UserNameRequest = Request.Request<Option.Option<string>, SfError> & {
  readonly _tag: 'UserNameRequest';
  readonly userId: string;
};

const UserNameRequest = Request.tagged<UserNameRequest>('UserNameRequest');

/** Per-org user-name cache with no TTL for successful names. */
export type UserNameCache = Cache.Cache<UserNameRequest, Option.Option<string>, SfError>;

export const calculateTimeout =
  (logger: PinoLogger) =>
  (memberCount: number, overriddenTimeout = 0): Duration.Duration => {
    if (overriddenTimeout > 0) {
      logger.debug(`Overriding SourceMember polling timeout to ${overriddenTimeout}`);
      return Duration.seconds(overriddenTimeout);
    }

    // Calculate 50s per 1000 members, plus a 5s buffer.
    const pollingTimeout = Math.ceil(memberCount * 0.05) + 5;
    logger.debug(`Computed SourceMember polling timeout of ${pollingTimeout}s`);
    return Duration.seconds(pollingTimeout);
  };

/** @internal */
export const querySourceMembersTo = Effect.fn('querySourceMembersTo')(function* (conn: Connection, toRevision: number) {
  const query = `SELECT ${SOURCE_MEMBER_FIELDS.join(', ')} FROM SourceMember WHERE RevisionCounter <= ${toRevision}`;
  return yield* queryFn(conn, query);
});

export type QuerySourceMembersFromOptions = {
  conn: Connection;
  fromRevision: number;
  /** Optional per-org cache shared by remote tracking queries. */
  userNameCache?: UserNameCache;
  logger?: PinoLogger;
};

/** @internal */
export const querySourceMembersFrom = Effect.fn('querySourceMembersFrom')(function* ({
  conn,
  fromRevision,
  userNameCache,
  logger,
}: QuerySourceMembersFromOptions) {
  const query = `SELECT ${SOURCE_MEMBER_FIELDS.join(', ')} FROM SourceMember WHERE RevisionCounter > ${fromRevision}`;
  logger?.debug(`Query: ${query}`);
  const queryResult = yield* queryFn(conn, query);
  const userNames = userNameCache ? yield* resolveUserNames(queryResult, userNameCache) : new Map();

  const resolved = queryResult.map((member) => ({
    ...member,
    ChangedBy: getResolvedUserName(member.ChangedBy, userNames),
  }));
  return resolved;
});

/** Build a batched, per-user cache. Successful names live for the cache's lifetime. */
/** @internal */
export const makeUserNameCache = Effect.fn('makeUserNameCache')(function* (conn: Connection) {
  const resolver = RequestResolver.make<UserNameRequest>(
    Effect.fnUntraced(function* (entries) {
      const userIds = Array.from(new Set(entries.map(({ request }) => request.userId)));
      const userQuery = `SELECT Id, Name FROM User WHERE Id IN ('${userIds.join("','")}')`;
      const result = yield* Effect.tryPromise({
        try: () => conn.query<{ Id: string; Name: string }>(userQuery, { autoFetch: true, maxFetch: MAX_FETCH }),
        catch: (cause) => SfError.wrap(cause),
      });
      const namesById = new Map(
        result.records.map((user) => [trimTo15(user.Id), user.Name] satisfies readonly [string, string])
      );
      entries.forEach((entry) => {
        const name = namesById.get(entry.request.userId);
        entry.completeUnsafe(Exit.succeed(name === undefined ? Option.none() : Option.some(name)));
      });
    })
  );
  return yield* RequestResolver.asCache(resolver, {
    // One Tooling query can return at most this many SourceMembers / distinct ChangedBy IDs.
    capacity: MAX_FETCH,
    timeToLive: (exit) => (Exit.isSuccess(exit) && Option.isSome(exit.value) ? Duration.infinity : Duration.zero),
  });
});

const resolveUserNames = Effect.fnUntraced(function* (
  queryResult: readonly SourceMember[],
  userNameCache: UserNameCache
) {
  const userIds = Array.from(new Set(queryResult.map((member) => trimTo15(member.ChangedBy))));
  const names = yield* Effect.forEach(userIds, (userId) => Cache.get(userNameCache, UserNameRequest({ userId })), {
    concurrency: 'unbounded',
  });
  return new Map(
    userIds.map((userId, index) => [userId, names[index]] satisfies readonly [string, Option.Option<string>])
  );
});

const getResolvedUserName = (userId: string, userNames: Map<string, Option.Option<string>>): string => {
  const name = userNames.get(trimTo15(userId));
  return name && Option.isSome(name) ? name.value : userId;
};

/** Mutable only as a test seam for replacing the external Salesforce query operations. */
/** @internal */
export const sourceMemberQueries = { querySourceMembersTo, querySourceMembersFrom };

const queryFn = Effect.fnUntraced(function* (conn: Connection, query: string) {
  const result = yield* Effect.tryPromise({
    try: () => conn.tooling.query<SourceMember>(query, { autoFetch: true, maxFetch: MAX_FETCH }),
    catch: (cause) => SfError.wrap(cause),
  });
  return result.records.map(sourceMemberCorrections);
});

const sourceMemberCorrections = (sourceMember: SourceMember): SourceMember =>
  sourceMember.MemberType === 'QuickActionDefinition'
    ? { ...sourceMember, MemberType: 'QuickAction' } // W-15837125
    : sourceMember;
