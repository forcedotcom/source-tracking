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

/** represents the contents of the config file stored in 'maxRevision.json' */

export type ContentsV1 = {
  fileVersion: 1;
  serverMaxRevisionCounter: number;
  sourceMembers: Record<string, MemberRevision>;
};

export type ContentsV0 = {
  fileVersion?: 0;
  serverMaxRevisionCounter: number;
  sourceMembers: Record<string, MemberRevisionLegacy>;
};

export type SourceMember = {
  MemberType: string;
  MemberName: string;
  /** The change is a delete */
  IsNameObsolete: boolean;
  /** The change is an add (newly created metadata) */
  IsNewMember: boolean;
  RevisionCounter: number;
  /** The recordId of the metadata */
  MemberIdOrName: string;
  /** userID of the person who made change */
  ChangedBy: string;
  LastModifiedDate: string;
};

export type MemberRevision = SourceMember & {
  /** the last revision retrieved.  Used for detecting changes*/
  lastRetrievedFromServer?: number;
};

/**
 * @deprecated replaced by the new MemberRevision
 * used for reading and writing the legacy tracking file format
 */
export type MemberRevisionLegacy = {
  memberType: string;
  serverRevisionCounter: number;
  lastRetrievedFromServer: number | null;
  isNameObsolete: boolean;
};

export const SOURCE_MEMBER_FIELDS = [
  'MemberIdOrName',
  'MemberType',
  'MemberName',
  'IsNameObsolete',
  'RevisionCounter',
  'IsNewMember',
  'ChangedBy',
  'LastModifiedDate',
] satisfies Array<keyof SourceMember>;
