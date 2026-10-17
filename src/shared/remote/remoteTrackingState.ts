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

import { getMetadataKey } from '../functions.js';
import { MemberRevision, SourceMember } from './types.js';

/** The in-memory form of one project's persisted remote tracking snapshot. */
export type RemoteTrackingState = {
  serverMaxRevisionCounter: number;
  sourceMembers: Map<string, MemberRevision>;
  /** Lazily built index for URI-encoded and decoded metadata keys. */
  decodedKeyIndex?: Map<string, string>;
};

export const emptyRemoteTrackingState = (): RemoteTrackingState => ({
  serverMaxRevisionCounter: 0,
  sourceMembers: new Map(),
});

/** Apply server results to the operation-local snapshot. */
export const trackSourceMembers = (
  state: RemoteTrackingState,
  sourceMembers: readonly SourceMember[],
  { markRetrievedFromServer = false }: { markRetrievedFromServer?: boolean } = {}
): void => {
  if (sourceMembers.length === 0) return;

  // This Map is operation-local; mutate its counter rather than clone a large SourceMember snapshot.
  // eslint-disable-next-line no-param-reassign
  state.serverMaxRevisionCounter = Math.max(
    state.serverMaxRevisionCounter,
    ...sourceMembers.map((member) => member.RevisionCounter)
  );

  sourceMembers.forEach((member) => {
    const key = getMetadataKey(member.MemberType, member.MemberName);
    const previous = getSourceMember(state, key);
    setMemberRevision(state, key, {
      ...member,
      lastRetrievedFromServer: markRetrievedFromServer ? member.RevisionCounter : previous?.lastRetrievedFromServer,
    });
  });
};

/** Return a tracked element, resolving either form of an encoded metadata key. */
export const getSourceMember = (state: RemoteTrackingState, key: string): MemberRevision | undefined =>
  state.sourceMembers.get(resolveStoredKey(state, key));

/** Update a tracked element without losing the spelling of its stored key. */
export const setMemberRevision = (state: RemoteTrackingState, key: string, sourceMember: MemberRevision): void => {
  const matchingKey = resolveStoredKey(state, key);
  state.sourceMembers.set(matchingKey, {
    ...sourceMember,
    MemberName: decodeURIComponent(sourceMember.MemberName),
  });
  if (state.decodedKeyIndex) {
    const decodedKey = tryDecodeURIComponent(matchingKey);
    if (decodedKey !== undefined) {
      state.decodedKeyIndex.set(decodedKey, matchingKey);
    }
  }
};

/** Prefer the exact persisted spelling, then fall back to its decoded alias. */
const resolveStoredKey = (state: RemoteTrackingState, key: string): string =>
  state.sourceMembers.has(key) ? key : resolveDecodedKey(state, key);

/** Resolve the stored key from a decoded key in O(1) after the first lookup. */
const resolveDecodedKey = (state: RemoteTrackingState, key: string): string => {
  // The reverse index is operation-local and built only on first decoded-key lookup.
  // eslint-disable-next-line no-param-reassign
  state.decodedKeyIndex ??= buildDecodedKeyIndex(state.sourceMembers);
  try {
    return state.decodedKeyIndex.get(decodeURIComponent(key)) ?? key;
  } catch {
    return key;
  }
};

const buildDecodedKeyIndex = (sourceMembers: Map<string, MemberRevision>): Map<string, string> => {
  const index = new Map<string, string>();
  for (const key of sourceMembers.keys()) {
    const decodedKey = tryDecodeURIComponent(key);
    if (decodedKey !== undefined) {
      index.set(decodedKey, key);
    }
  }
  return index;
};

const tryDecodeURIComponent = (key: string): string | undefined => {
  try {
    return decodeURIComponent(key);
  } catch {
    // The exact persisted key remains addressable; it just has no decoded alias.
    return undefined;
  }
};
