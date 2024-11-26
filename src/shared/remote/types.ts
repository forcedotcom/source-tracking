/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
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
] satisfies Array<keyof SourceMember>;
