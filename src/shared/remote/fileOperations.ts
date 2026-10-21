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
import fs from 'graceful-fs';
import { lockInit, Logger, SfError } from '@salesforce/core';
import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import { isNotUndefined } from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import {
  getLegacyMetadataKey,
  getMetadataKey,
  getMetadataNameFromLegacyKey,
  getMetadataTypeFromLegacyKey,
} from '../functions.js';
import { RemoteChangeElement } from '../types.js';
import { ContentsJsonSchema } from './types.js';
import type { ContentsV0, ContentsV1, MemberRevision, MemberRevisionLegacy } from './types.js';

const FILENAME = 'maxRevision.json';
const FILE_VERSION_ENV = 'SF_SOURCE_TRACKING_FILE_VERSION';

export type RemoteTrackingIdentity = {
  projectPath: string;
  orgId: string;
};

class TrackingFileReadError extends Schema.TaggedError<TrackingFileReadError>()('TrackingFileReadError', {
  filePath: Schema.String,
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

export const getFilePath = ({ projectPath, orgId }: RemoteTrackingIdentity): string =>
  path.join(projectPath, '.sf', 'orgs', orgId, FILENAME);

export const trackingFileExists = (filePath: string): boolean => fs.existsSync(filePath);

/** Read and normalize either persisted file version. Read/parse failures mean an empty snapshot. */
export const readFileContents = Effect.fnUntraced(function* (filePath: string) {
  const contents = yield* Effect.tryPromise({
    try: async () => {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = Schema.decodeUnknownSync(ContentsJsonSchema)(raw);
      return parsed.fileVersion === 1 ? parsed : upgradeFileContents(parsed);
    },
    catch: (cause) => new TrackingFileReadError({ filePath, cause, message: String(cause) }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.sync(() =>
        Logger.childFromRoot('remoteSourceTracking:readFileContents').debug(
          `Error reading or parsing file at ${filePath}. Will treat as an empty file: ${cause.message}`,
          cause.cause
        )
      )
    ),
    Effect.catchTag('TrackingFileReadError', () => Effect.succeed({}))
  );
  return contents;
});

export const revisionToRemoteChangeElement = (memberRevision: MemberRevision): RemoteChangeElement => ({
  type: memberRevision.MemberType,
  name: memberRevision.MemberName,
  deleted: memberRevision.IsNameObsolete,
  modified: memberRevision.IsNewMember === false,
  revisionCounter: memberRevision.RevisionCounter,
  changedBy: memberRevision.ChangedBy,
  memberIdOrName: memberRevision.MemberIdOrName,
  lastModifiedDate: memberRevision.LastModifiedDate,
});

const upgradeFileContents = (contents: ContentsV0): ContentsV1 => ({
  fileVersion: 1,
  serverMaxRevisionCounter: contents.serverMaxRevisionCounter,
  sourceMembers: Object.fromEntries(
    Object.entries(contents.sourceMembers).map(([key, value]) => [
      getMetadataKey(getMetadataTypeFromLegacyKey(key), getMetadataNameFromLegacyKey(key)),
      {
        MemberName: getMetadataNameFromLegacyKey(key),
        MemberType: value.memberType,
        IsNameObsolete: value.isNameObsolete,
        RevisionCounter: value.serverRevisionCounter,
        lastRetrievedFromServer: value.lastRetrievedFromServer ?? undefined,
        ChangedBy: 'unknown',
        MemberIdOrName: 'unknown',
        LastModifiedDate: 'unknown',
      },
    ])
  ),
});

/** @internal */
export const writeTrackingFile = Effect.fnUntraced(function* ({
  filePath,
  maxCounter,
  members,
  baseMaxCounter,
  replace = false,
}: {
  filePath: string;
  maxCounter: number;
  members: Map<string, MemberRevision>;
  /** Counter in the file when this operation started; prevents stale writes after a reset. */
  baseMaxCounter?: number;
  /** Reset replaces the snapshot instead of merging it with the previous contents. */
  replace?: boolean;
}) {
  const provider = ConfigProvider.fromEnv();
  const currentFileVersion = yield* Config.Number(FILE_VERSION_ENV)
    .pipe(Config.withDefault(0))
    .parse(provider)
    .pipe(Effect.orDie);

  const incoming: ContentsV1 = {
    fileVersion: 1,
    serverMaxRevisionCounter: maxCounter,
    sourceMembers: Object.fromEntries(members),
  };

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => lockInit(filePath),
          catch: (cause) => SfError.wrap(cause),
        }),
        (lockResult) =>
          Effect.tryPromise({
            try: () => lockResult.unlock(),
            catch: (cause) => SfError.wrap(cause),
          }).pipe(Effect.catch(() => Effect.void))
      );

      const latestContents = yield* readFileContents(filePath);
      const latest: ContentsV1 =
        'sourceMembers' in latestContents
          ? latestContents
          : { fileVersion: 1, serverMaxRevisionCounter: 0, sourceMembers: {} };
      const committed = replace
        ? incoming
        : isNotUndefined(baseMaxCounter) && latest.serverMaxRevisionCounter < baseMaxCounter
        ? latest
        : mergeTrackingContents(latest, incoming);
      const persisted =
        currentFileVersion === 1
          ? committed
          : ({
              fileVersion: 0,
              serverMaxRevisionCounter: committed.serverMaxRevisionCounter,
              sourceMembers: Object.fromEntries(
                Object.entries(committed.sourceMembers).map(([key, member]) => toLegacyMemberRevision([key, member]))
              ),
            } satisfies ContentsV0);
      yield* Effect.try({
        try: () => Schema.encodeSync(ContentsJsonSchema)(persisted),
        catch: (cause) => SfError.wrap(cause),
      }).pipe(
        Effect.flatMap((encoded) =>
          // Node's write cannot be cancelled safely; keep the lock until it settles.
          Effect.tryPromise({
            try: () => fs.promises.writeFile(filePath, encoded),
            catch: (cause) => SfError.wrap(cause),
          }).pipe(Effect.uninterruptible)
        )
      );
      return committed;
    })
  );
});

const mergeTrackingContents = (latest: ContentsV1, incoming: ContentsV1): ContentsV1 => {
  const sourceMembers = { ...latest.sourceMembers };
  Object.entries(incoming.sourceMembers).forEach(([key, incomingMember]) => {
    const latestMember = sourceMembers[key];
    if (!latestMember || incomingMember.RevisionCounter > latestMember.RevisionCounter) {
      sourceMembers[key] = incomingMember;
    } else if (incomingMember.RevisionCounter === latestMember.RevisionCounter) {
      const lastRetrievedFromServer = Math.max(
        latestMember.lastRetrievedFromServer ?? -1,
        incomingMember.lastRetrievedFromServer ?? -1
      );
      sourceMembers[key] = {
        ...latestMember,
        ...incomingMember,
        lastRetrievedFromServer: lastRetrievedFromServer < 0 ? undefined : lastRetrievedFromServer,
      };
    }
  });
  return {
    fileVersion: 1,
    serverMaxRevisionCounter: Math.max(latest.serverMaxRevisionCounter, incoming.serverMaxRevisionCounter),
    sourceMembers,
  };
};

const toLegacyMemberRevision = ([, member]: [key: string, member: MemberRevision]): [
  key: string,
  MemberRevisionLegacy
] => [
  getLegacyMetadataKey(member.MemberType, member.MemberName),
  {
    memberType: member.MemberType,
    serverRevisionCounter: member.RevisionCounter,
    lastRetrievedFromServer: member.lastRetrievedFromServer ?? null,
    isNameObsolete: member.IsNameObsolete,
  },
];
