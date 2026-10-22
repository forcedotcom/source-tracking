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

import path from 'node:path';
import { EOL } from 'node:os';
import fs from 'graceful-fs';
import { Logger, Lifecycle, Messages, type Org, SfError } from '@salesforce/core';
import * as Cache from 'effect/Cache';
import * as Chunk from 'effect/Chunk';
import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HashMap from 'effect/HashMap';
import * as HashSet from 'effect/HashSet';
import * as Option from 'effect/Option';
import { isNotUndefined, isUndefined } from 'effect/Predicate';
import * as Ref from 'effect/Ref';
import * as Schedule from 'effect/Schedule';
import * as Stream from 'effect/Stream';
import { type RegistryAccess } from '@salesforce/source-deploy-retrieve';
import {
  type ChangeResult,
  type RemoteChangeElement,
  type RemoteSyncInput,
  type SourceMemberPollingEvent,
} from '../types.js';
import { getMetadataKeyFromFileResponse, getMappingsForSourceMemberTypesToMetadataType } from '../metadataKeys.js';
import { getMetadataKey, TYPES_WITH_SOURCEMEMBER_NAME_MISMATCH } from '../functions.js';
import { calculateExpectedSourceMembers } from './expectedSourceMembers.js';
import type { MemberRevision, PinoLogger, SourceMember } from './types.js';
import {
  getFilePath,
  readFileContents,
  type RemoteTrackingIdentity,
  revisionToRemoteChangeElement,
  trackingFileExists,
  writeTrackingFile,
} from './fileOperations.js';
import { calculateTimeout, makeUserNameCache, sourceMemberQueries } from './orgQueries.js';
import type { UserNameCache } from './orgQueries.js';
import {
  emptyRemoteTrackingState,
  getSourceMember,
  type RemoteTrackingState,
  setMemberRevision,
  sourceMemberMatchesKey,
  stripSourceMemberEntitySuffix,
  trackSourceMembers,
} from './remoteTrackingState.js';

const POLLING_DELAY_MS = 1000;
const SOURCE_MEMBER_POLLING_TIMEOUT = 'SF_SOURCE_MEMBER_POLLING_TIMEOUT';
const DISABLE_SOURCE_MEMBER_POLLING = 'SF_DISABLE_SOURCE_MEMBER_POLLING';
const DEFAULT_EMPTY_POLLING_RESULT_LIMIT = 120;

export type RemoteTrackingOptions = {
  org: Org;
  identity: RemoteTrackingIdentity;
};

export type RemoteTrackingCaches = {
  readonly sourceMembers: Cache.Cache<number, SourceMember[], SfError>;
  readonly userNames: UserNameCache;
};

type PollBatch = { readonly members: SourceMember[]; readonly continuePolling: boolean };
type PollState = {
  readonly highestRevisionSoFar: number;
  readonly pollAttempts: number;
  readonly consecutiveEmptyResults: number;
  readonly someResultsReturned: boolean;
  readonly outstandingSourceMembers: HashMap.HashMap<string, RemoteSyncInput>;
  readonly bonusMemberKeys: HashSet.HashSet<string>;
};

/** Validate the org and create an empty tracking file when this project has none. */
/** @internal */
export const initializeRemoteTracking = Effect.fn('initializeRemoteTracking')(function* ({
  org,
  identity,
}: RemoteTrackingOptions) {
  const supported = yield* Effect.tryPromise({
    try: () => org.supportsSourceTracking(),
    catch: (cause) => SfError.wrap(cause),
  });
  if (!supported) {
    yield* Effect.sync(() => Messages.importMessagesDirectoryFromMetaUrl(import.meta.url));
    const messages = Messages.loadMessages('@salesforce/source-tracking', 'source');
    return yield* Effect.fail(new SfError(messages.getMessage('NonSourceTrackedOrgError'), 'NonSourceTrackedOrgError'));
  }

  const filePath = getFilePath(identity);
  if (!trackingFileExists(filePath)) {
    yield* writeTrackingFile({ filePath, maxCounter: 0, members: new Map() });
  }
});

/** Load the file-backed snapshot for one operation. No state is retained after the Effect completes. */
const readRemoteTracking = Effect.fn('readRemoteTracking')(function* (identity: RemoteTrackingIdentity) {
  const contents = yield* readFileContents(getFilePath(identity));
  if (!('serverMaxRevisionCounter' in contents) || !('sourceMembers' in contents)) {
    return emptyRemoteTrackingState();
  }
  return {
    serverMaxRevisionCounter: contents.serverMaxRevisionCounter,
    sourceMembers: new Map(Object.entries(contents.sourceMembers)),
  };
});

/** Build per-SourceTracking caches for revision results and stable user names for this org. */
/** @internal */
export const makeRemoteTrackingCaches = Effect.fn('makeRemoteTrackingCaches')(function* ({
  org,
}: RemoteTrackingOptions) {
  const userNames = yield* makeUserNameCache(org.getConnection());
  const sourceMembers = yield* Cache.makeWith<number, SourceMember[], SfError>(
    (fromRevision) =>
      sourceMemberQueries.querySourceMembersFrom({
        conn: org.getConnection(),
        fromRevision,
        logger: getLogger(),
        userNameCache: userNames,
      }),
    {
      // Keep only the current revision result; same-key concurrent lookups still coalesce.
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }
  );
  return { sourceMembers, userNames };
});

/** @internal */
export const retrieveRemoteChanges = Effect.fn('retrieveRemoteChanges')(function* ({
  org,
  identity,
  queryCache,
  userNameCache,
}: RemoteTrackingOptions & { queryCache?: RemoteTrackingCaches; userNameCache?: UserNameCache }) {
  const logger = getLogger();
  const state = yield* readRemoteTracking(identity);
  const baseMaxCounter = state.serverMaxRevisionCounter;
  const names = userNameCache ?? queryCache?.userNames ?? (yield* makeUserNameCache(org.getConnection()));
  const queriedSourceMembers = queryCache
    ? yield* Cache.get(queryCache.sourceMembers, state.serverMaxRevisionCounter)
    : yield* sourceMemberQueries.querySourceMembersFrom({
        fromRevision: state.serverMaxRevisionCounter,
        logger,
        userNameCache: names,
        conn: org.getConnection(),
      });
  trackSourceMembers(state, queriedSourceMembers);

  const committed =
    queriedSourceMembers.length > 0
      ? yield* writeRemoteTracking(identity, state, { baseMaxCounter })
      : {
          serverMaxRevisionCounter: state.serverMaxRevisionCounter,
          sourceMembers: Object.fromEntries(state.sourceMembers),
        };

  const changes = Object.values(committed.sourceMembers).filter(doesNotMatchServer).map(revisionToRemoteChangeElement);
  logger.debug(
    changes.length ? `Found ${changes.length} elements not synced with org` : 'Remote source tracking is up to date'
  );
  return changes;
});

/** Poll, merge and sync in one operation so the snapshot is written once. */
/** @internal */
export const updateRemoteTracking = Effect.fn('updateRemoteTracking')(function* ({
  org,
  identity,
  registry,
  elements,
  skipPolling = false,
}: RemoteTrackingOptions & {
  registry: RegistryAccess;
  elements: RemoteSyncInput[];
  skipPolling?: boolean;
}) {
  if (elements.length === 0) return;

  const logger = getLogger();
  const state = yield* readRemoteTracking(identity);
  const baseMaxCounter = state.serverMaxRevisionCounter;
  if (!skipPolling) yield* pollForSourceTracking({ org, registry, elements, state, logger });
  syncSpecifiedElements({ registry, elements, state, logger });
  yield* writeRemoteTracking(identity, state, { baseMaxCounter });
});

/** @internal */
export const resetRemoteTracking = Effect.fn('resetRemoteTracking')(function* ({
  org,
  identity,
  toRevision,
  userNameCache,
}: RemoteTrackingOptions & { toRevision?: number; userNameCache?: UserNameCache }) {
  const logger = getLogger();
  const state = emptyRemoteTrackingState();
  const names = userNameCache ?? (isUndefined(toRevision) ? yield* makeUserNameCache(org.getConnection()) : undefined);
  const members = isNotUndefined(toRevision)
    ? yield* sourceMemberQueries.querySourceMembersTo(org.getConnection(), toRevision)
    : yield* sourceMemberQueries.querySourceMembersFrom({
        fromRevision: 0,
        logger,
        userNameCache: names,
        conn: org.getConnection(),
      });

  trackSourceMembers(state, members, { markRetrievedFromServer: true });
  yield* writeRemoteTracking(identity, state, { replace: true });
  return members.map((member) => getMetadataKey(member.MemberType, member.MemberName));
});

/** @internal */
export const deleteRemoteTracking = Effect.fn('deleteRemoteTracking')(function* (identity: RemoteTrackingIdentity) {
  const filePath = getFilePath(identity);
  if (trackingFileExists(filePath)) {
    yield* Effect.tryPromise({
      try: () => fs.promises.unlink(filePath),
      catch: (cause) => SfError.wrap(cause),
    });
  }
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
});

const writeRemoteTracking = (
  identity: RemoteTrackingIdentity,
  state: RemoteTrackingState,
  options: { baseMaxCounter?: number; replace?: boolean } = {}
) =>
  writeTrackingFile({
    filePath: getFilePath(identity),
    maxCounter: state.serverMaxRevisionCounter,
    members: state.sourceMembers,
    ...options,
  });

const syncSpecifiedElements = ({
  registry,
  elements,
  state,
  logger,
}: {
  registry: RegistryAccess;
  elements: RemoteSyncInput[];
  state: RemoteTrackingState;
  logger: PinoLogger;
}): void => {
  if (elements.length === 0) return;

  const quietLogger: (message: string) => void =
    elements.length > 100 ? logger.silent?.bind(logger) ?? ((): void => {}) : logger.debug.bind(logger);
  quietLogger(`Syncing ${elements.length} Revisions by key`);
  const metadataKeysFromFileResponse = getMetadataKeyFromFileResponse(registry);
  const metadataKeys = new Set(elements.flatMap(metadataKeysFromFileResponse));
  metadataKeys.forEach((metadataKey) => {
    const match = findSourceMemberToSync(state, metadataKey);
    if (!match) {
      logger.warn(`found no matching revision for ${metadataKey}`);
    } else if (doesNotMatchServer(match.member)) {
      quietLogger(
        `Syncing ${match.key} revision from ${match.member.lastRetrievedFromServer ?? 'null'} to ${
          match.member.RevisionCounter
        }`
      );
      setMemberRevision(state, match.key, {
        ...match.member,
        lastRetrievedFromServer: match.member.RevisionCounter,
      });
    }
  });
};

const pollForSourceTracking = Effect.fn('pollForSourceTracking')(function* ({
  org,
  registry,
  elements,
  state,
  logger,
}: Pick<RemoteTrackingOptions, 'org'> & {
  registry: RegistryAccess;
  elements: RemoteSyncInput[];
  state: RemoteTrackingState;
  logger: PinoLogger;
}) {
  const pollingDisabled = yield* Config.String(DISABLE_SOURCE_MEMBER_POLLING)
    .pipe(
      Config.withDefault('false'),
      Config.map((value) => value.toLowerCase() === 'true' || value === '1')
    )
    .parse(ConfigProvider.fromEnv())
    .pipe(Effect.catchTag('ConfigError', () => Effect.succeed(false)));
  if (pollingDisabled) {
    logger.warn('Not polling for SourceMembers since SF_DISABLE_SOURCE_MEMBER_POLLING = true.');
    return;
  }
  if (elements.length === 0) return;

  const expectedSourceMembers = calculateExpectedSourceMembers(registry, elements);
  const originalOutstandingSize = expectedSourceMembers.size;
  const timeoutOverride = yield* Config.option(Config.Number(SOURCE_MEMBER_POLLING_TIMEOUT))
    .parse(ConfigProvider.fromEnv())
    .pipe(Effect.catchTag('ConfigError', () => Effect.succeed(Option.none<number>())));
  const overriddenTimeout = Option.getOrElse(timeoutOverride, () => 0);
  const consecutiveEmptyPollLimit = Option.getOrElse(
    Option.map(timeoutOverride, (seconds) => seconds / Duration.toSeconds(Duration.millis(POLLING_DELAY_MS))),
    () => DEFAULT_EMPTY_POLLING_RESULT_LIMIT
  );
  const pollingTimeout = calculateTimeout(logger)(expectedSourceMembers.size, overriddenTimeout);
  const pollState = yield* Ref.make<PollState>({
    highestRevisionSoFar: state.serverMaxRevisionCounter,
    pollAttempts: 0,
    consecutiveEmptyResults: 0,
    someResultsReturned: false,
    outstandingSourceMembers: HashMap.fromIterable(expectedSourceMembers),
    bonusMemberKeys: HashSet.empty(),
  });

  logger.debug(
    `Polling for ${expectedSourceMembers.size} SourceMembers from revision ${
      state.serverMaxRevisionCounter
    } with timeout of ${Duration.toSeconds(pollingTimeout)}s`
  );

  const pollOnce = Effect.fnUntraced(function* () {
    const before = yield* Ref.get(pollState);
    const pollAttempt = before.pollAttempts + 1;
    yield* Ref.update(pollState, (current) => ({ ...current, pollAttempts: pollAttempt }));
    const queryResult = yield* sourceMemberQueries
      .querySourceMembersFrom({
        conn: org.getConnection(),
        fromRevision: before.highestRevisionSoFar,
        logger: pollAttempt > 1 ? undefined : logger,
      })
      .pipe(
        Effect.map((members) => ({ members, queryFailed: false })),
        Effect.catch((cause) =>
          Effect.as(
            Effect.sync(() => logger.debug(`SourceMember poll ${pollAttempt} failed: ${String(cause)}`)),
            { members: [] satisfies SourceMember[], queryFailed: true }
          )
        )
      );
    const queriedMembers = queryResult.members;

    yield* Ref.update(pollState, (current) => {
      const { outstandingSourceMembers, unmatchedMembers } = matchPolledSourceMembers(
        current.outstandingSourceMembers,
        queriedMembers
      );
      return {
        ...current,
        outstandingSourceMembers,
        bonusMemberKeys: unmatchedMembers.pipe(
          Chunk.map((member) => getMetadataKey(member.MemberType, member.MemberName)),
          HashSet.fromIterable,
          HashSet.union(current.bonusMemberKeys)
        ),
        highestRevisionSoFar:
          queriedMembers.length > 0
            ? Math.max(current.highestRevisionSoFar, ...queriedMembers.map((member) => member.RevisionCounter))
            : current.highestRevisionSoFar,
        consecutiveEmptyResults:
          queriedMembers.length > 0
            ? 0
            : queryResult.queryFailed
            ? current.consecutiveEmptyResults
            : current.consecutiveEmptyResults + 1,
        someResultsReturned: current.someResultsReturned || queriedMembers.length > 0,
      };
    });
    const current = yield* Ref.get(pollState);

    yield* Effect.tryPromise({
      try: () =>
        Lifecycle.getInstance().emit('sourceMemberPollingEvent', {
          original: originalOutstandingSize,
          remaining: HashMap.size(current.outstandingSourceMembers),
          attempts: current.pollAttempts,
          consecutiveEmptyResults: current.consecutiveEmptyResults,
        } satisfies SourceMemberPollingEvent),
      catch: (cause) => SfError.wrap(cause),
    }).pipe(Effect.catch((cause) => Effect.sync(() => logger.debug(`Unable to emit polling event: ${cause.message}`))));

    logger.debug(
      `[${current.pollAttempts}] Found ${
        originalOutstandingSize - HashMap.size(current.outstandingSourceMembers)
      } of ${originalOutstandingSize} expected SourceMembers`
    );
    const complete = HashMap.size(current.outstandingSourceMembers) === 0;
    const stopped = current.someResultsReturned && current.consecutiveEmptyResults >= consecutiveEmptyPollLimit;

    if (!complete && !stopped) {
      logger.debug(
        HashMap.size(current.outstandingSourceMembers) < 20
          ? `Still looking for SourceMembers: ${Array.from(HashMap.keys(current.outstandingSourceMembers)).join(',')}`
          : `Still looking for ${HashMap.size(current.outstandingSourceMembers)} Source Members`
      );
    }
    return { members: queriedMembers, continuePolling: !complete && !stopped } satisfies PollBatch;
  });

  const pollingSchedule = Schedule.spaced(Duration.millis(POLLING_DELAY_MS)).pipe(
    Schedule.upTo({ duration: pollingTimeout }),
    Schedule.while(({ input }: Schedule.Metadata<unknown, PollBatch>) => input.continuePolling)
  );
  yield* Stream.fromEffectSchedule(pollOnce(), pollingSchedule).pipe(
    Stream.runForEach(({ members }) => Effect.sync(() => trackSourceMembers(state, members)))
  );
  const completedPollState = yield* Ref.get(pollState);

  if (HashMap.size(completedPollState.outstandingSourceMembers) === 0) {
    logger.debug(`Retrieved all SourceMember data after ${completedPollState.pollAttempts} attempts`);
    if (HashSet.size(completedPollState.bonusMemberKeys) > 0) {
      yield* Effect.tryPromise({
        try: () =>
          Lifecycle.getInstance().emitTelemetry({
            eventName: 'sourceMemberBonusTypes',
            library: 'SourceTracking',
            deploymentSize: elements.length,
            bonusTypes: Array.from(completedPollState.bonusMemberKeys).sort().join(','),
          }),
        catch: (cause) => SfError.wrap(cause),
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => logger.debug(`Unable to emit SourceMember bonus telemetry: ${cause.message}`))
        )
      );
    }
    return;
  }

  yield* emitPollingTimeout({
    outstandingSourceMembers: completedPollState.outstandingSourceMembers,
    pollAttempts: completedPollState.pollAttempts,
    consecutiveEmptyResults: completedPollState.consecutiveEmptyResults,
    pollingTimeout,
    deploymentSize: elements.length,
    bonusMemberKeys: completedPollState.bonusMemberKeys,
  });
});

const findSourceMemberToSync = (
  state: RemoteTrackingState,
  metadataKey: string
): { key: string; member: MemberRevision } | undefined => {
  const member = getSourceMember(state, metadataKey);
  if (member) return { key: metadataKey, member };

  const suffixlessKey = stripSourceMemberEntitySuffix(metadataKey);
  const suffixlessMember = getSourceMember(state, suffixlessKey);
  if (suffixlessMember) return { key: suffixlessKey, member: suffixlessMember };
  if (!Array.from(TYPES_WITH_SOURCEMEMBER_NAME_MISMATCH).some((type) => metadataKey.startsWith(`${type}###`))) {
    return undefined;
  }

  const matches = Array.from(state.sourceMembers).filter(([, candidate]) =>
    sourceMemberMatchesKey(candidate, metadataKey)
  );
  return matches.length === 1 ? { key: matches[0][0], member: matches[0][1] } : undefined;
};

const getExpectedSourceMemberKey = (
  outstanding: HashMap.HashMap<string, RemoteSyncInput>,
  member: SourceMember
): string | undefined => {
  const key = getMetadataKey(member.MemberType, member.MemberName);
  if (HashMap.has(outstanding, key)) return key;

  const matches = Array.from(HashMap.keys(outstanding)).filter((candidate) =>
    sourceMemberMatchesKey(member, candidate)
  );
  return matches.length === 1 ? matches[0] : undefined;
};

const matchPolledSourceMembers = (
  outstandingSourceMembers: HashMap.HashMap<string, RemoteSyncInput>,
  members: Iterable<SourceMember>
): {
  outstandingSourceMembers: HashMap.HashMap<string, RemoteSyncInput>;
  unmatchedMembers: Chunk.Chunk<SourceMember>;
} => {
  const matched = Array.from(members).reduce(
    (current, member) => {
      const key = getExpectedSourceMemberKey(current.outstandingSourceMembers, member);
      return isNotUndefined(key)
        ? { ...current, outstandingSourceMembers: HashMap.remove(current.outstandingSourceMembers, key) }
        : { ...current, unmatchedMembers: Chunk.append(current.unmatchedMembers, member) };
    },
    { outstandingSourceMembers, unmatchedMembers: Chunk.empty<SourceMember>() }
  );

  // A later unique match can disambiguate an earlier member in this same query batch.
  return HashMap.size(matched.outstandingSourceMembers) < HashMap.size(outstandingSourceMembers) &&
    !Chunk.isEmpty(matched.unmatchedMembers)
    ? matchPolledSourceMembers(matched.outstandingSourceMembers, matched.unmatchedMembers)
    : matched;
};

const emitPollingTimeout = Effect.fnUntraced(function* ({
  outstandingSourceMembers,
  pollAttempts,
  consecutiveEmptyResults,
  pollingTimeout,
  deploymentSize,
  bonusMemberKeys,
}: {
  outstandingSourceMembers: HashMap.HashMap<string, RemoteSyncInput>;
  pollAttempts: number;
  consecutiveEmptyResults: number;
  pollingTimeout: Duration.Duration;
  deploymentSize: number;
  bonusMemberKeys: HashSet.HashSet<string>;
}) {
  const lifecycle = Lifecycle.getInstance();
  const warning = `Polling for ${HashMap.size(
    outstandingSourceMembers
  )} SourceMembers timed out after ${pollAttempts} attempts (last ${consecutiveEmptyResults} were empty).\n\nMissing SourceMembers:\n${formatSourceMemberWarnings(
    outstandingSourceMembers
  )}`;
  yield* Effect.all([
    Effect.tryPromise({ try: () => lifecycle.emitWarning(warning), catch: (cause) => SfError.wrap(cause) }),
    Effect.tryPromise({
      try: () =>
        lifecycle.emitTelemetry({
          eventName: 'sourceMemberPollingTimeout',
          library: 'SourceTracking',
          timeoutSeconds: Duration.toSeconds(pollingTimeout),
          attempts: pollAttempts,
          consecutiveEmptyResults,
          missingQuantity: HashMap.size(outstandingSourceMembers),
          deploymentSize,
          bonusTypes: Array.from(bonusMemberKeys).sort().join(','),
          types: [...new Set(Array.from(HashMap.values(outstandingSourceMembers)).map((member) => member.type))]
            .sort()
            .join(','),
          members: Array.from(HashMap.keys(outstandingSourceMembers)).join(','),
        }),
      catch: (cause) => SfError.wrap(cause),
    }),
  ]);
});

/** Convert a remote change to a pullable ChangeResult, correcting bundle types. */
export const remoteChangeElementToChangeResult = (
  registry: RegistryAccess
): ((rce: RemoteChangeElement) => ChangeResult) => {
  const mappings = getMappingsForSourceMemberTypesToMetadataType(registry);
  return (rce: RemoteChangeElement): ChangeResult => ({
    ...rce,
    ...(mappings.has(rce.type)
      ? {
          name: rce.type === 'EmailTemplateFolder' ? rce.name : rce.name.split('/')[0],
          type: mappings.get(rce.type),
        }
      : {}),
    origin: 'remote',
  });
};

const getLogger = (): PinoLogger => Logger.getRawRootLogger().child({ name: 'RemoteSourceTracking' });

const doesNotMatchServer = (member: MemberRevision): boolean =>
  member.RevisionCounter !== member.lastRetrievedFromServer;

const formatSourceMemberWarnings = (outstandingSourceMembers: HashMap.HashMap<string, RemoteSyncInput>): string => {
  const grouped = outstandingSourceMembers.pipe(
    HashMap.reduce(
      {
        namesByType: HashMap.empty<string, Chunk.Chunk<string>>(),
        types: Chunk.empty<string>(),
      },
      (acc, value) => {
        const names = acc.namesByType.pipe(HashMap.get(value.type));
        const nextNames: Chunk.Chunk<string> = names.pipe(
          Option.getOrElse(() => Chunk.empty<string>()),
          Chunk.append(value.fullName)
        );
        return {
          namesByType: acc.namesByType.pipe(HashMap.set(value.type, nextNames)),
          types: Option.isNone(names) ? Chunk.append(acc.types, value.type) : acc.types,
        };
      }
    )
  );
  return grouped.types.pipe(
    Chunk.map((type) => {
      const names = grouped.namesByType.pipe(
        HashMap.get(type),
        Option.getOrElse(() => Chunk.empty<string>())
      );
      return `  - ${type}: ${Chunk.join(names, ', ')}`;
    }),
    Chunk.join(EOL)
  );
};
