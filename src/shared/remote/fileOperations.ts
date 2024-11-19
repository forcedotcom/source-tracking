/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonMap } from '@salesforce/kit';
import { lockInit, envVars as env, Logger } from '@salesforce/core';
import {
  getLegacyMetadataKey,
  getMetadataKey,
  getMetadataNameFromLegacyKey,
  getMetadataTypeFromLegacyKey,
} from '../functions';
import { RemoteChangeElement } from '../types';
import { ContentsV0, ContentsV1, MemberRevision, MemberRevisionLegacy } from './types';

export const FILENAME = 'maxRevision.json';

export const getFilePath = (orgId: string): string => path.join('.sf', 'orgs', orgId, FILENAME);

export const readFileContents = async (filePath: string): Promise<ContentsV1 | Record<string, never>> => {
  try {
    const contents = await fs.promises.readFile(filePath, 'utf8');
    const parsedContents = parseJsonMap<ContentsV1 | ContentsV0>(contents, filePath);
    if (parsedContents.fileVersion === 1) {
      return parsedContents;
    }
    Logger.childFromRoot('remoteSourceTrackingService:readFileContents').debug(
      `older tracking file version, found ${
        parsedContents.fileVersion ?? 'undefined'
      }. Upgrading file contents.  Some expected data may be missing`
    );
    return upgradeFileContents(parsedContents);
  } catch (e) {
    Logger.childFromRoot('remoteSourceTrackingService:readFileContents').debug(
      `Error reading or parsing file file at ${filePath}.  Will treat as an empty file.`,
      e
    );

    return {};
  }
};

export const revisionToRemoteChangeElement = (memberRevision: MemberRevision): RemoteChangeElement => ({
  type: memberRevision.MemberType,
  name: memberRevision.MemberName,
  deleted: memberRevision.IsNameObsolete,
  modified: memberRevision.IsNewMember === false,
  revisionCounter: memberRevision.RevisionCounter,
  changedBy: memberRevision.ChangedBy,
  memberIdOrName: memberRevision.MemberIdOrName,
});

export const upgradeFileContents = (contents: ContentsV0): ContentsV1 => ({
  fileVersion: 1,
  serverMaxRevisionCounter: contents.serverMaxRevisionCounter,
  // @ts-expect-error the old file didn't store the IsNewMember field or any indication of whether the member was add/modified
  sourceMembers: Object.fromEntries(
    // it's the old version
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
      },
    ])
  ),
});

export const writeTrackingFile = async ({
  filePath,
  maxCounter,
  members,
}: {
  filePath: string;
  maxCounter: number;
  members: Map<string, MemberRevision>;
}): Promise<void> => {
  const lockResult = await lockInit(filePath);
  const CURRENT_FILE_VERSION_ENV = env.getNumber('SF_SOURCE_TRACKING_FILE_VERSION') ?? 0;
  const contents =
    CURRENT_FILE_VERSION_ENV === 1
      ? ({
          fileVersion: 1,
          serverMaxRevisionCounter: maxCounter,
          sourceMembers: Object.fromEntries(members),
        } satisfies ContentsV1)
      : ({
          fileVersion: 0,
          serverMaxRevisionCounter: maxCounter,
          sourceMembers: Object.fromEntries(Array.from(members.entries()).map(toLegacyMemberRevision)),
        } satisfies ContentsV0);
  await lockResult.writeAndUnlock(JSON.stringify(contents, null, 4));
};

export const toLegacyMemberRevision = ([, member]: [string, MemberRevision]): [key: string, MemberRevisionLegacy] => [
  getLegacyMetadataKey(member.MemberType, member.MemberName),
  {
    memberType: member.MemberType,
    serverRevisionCounter: member.RevisionCounter,
    lastRetrievedFromServer: member.lastRetrievedFromServer ?? null,
    isNameObsolete: member.IsNameObsolete,
  },
];
