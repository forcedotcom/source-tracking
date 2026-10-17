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

import { Logger } from '@salesforce/core';
import * as Schema from 'effect/Schema';

export type PinoLogger = ReturnType<(typeof Logger)['getRawRootLogger']>;

/** Source member fields persisted in V1 tracking files. */
export const SourceMemberSchema = Schema.Struct({
  MemberType: Schema.String,
  MemberName: Schema.String,
  /** The change is a delete */
  IsNameObsolete: Schema.Boolean,
  /** The change is an add (newly created metadata) */
  IsNewMember: Schema.Boolean,
  RevisionCounter: Schema.Number,
  /** The recordId of the metadata */
  MemberIdOrName: Schema.String,
  /** userID of the person who made change */
  ChangedBy: Schema.String,
  LastModifiedDate: Schema.String,
});
export type SourceMember = Schema.Schema.Type<typeof SourceMemberSchema>;

export const MemberRevisionSchema = Schema.Struct({
  ...SourceMemberSchema.fields,
  /** Not present in legacy tracking files; its absence preserves unknown add/modify status. */
  IsNewMember: Schema.optional(Schema.Boolean),
  /** the last revision retrieved.  Used for detecting changes*/
  lastRetrievedFromServer: Schema.optional(Schema.Number),
});
export type MemberRevision = Schema.Schema.Type<typeof MemberRevisionSchema>;

/**
 * @deprecated replaced by the new MemberRevision
 * used for reading and writing the legacy tracking file format
 */
export const MemberRevisionLegacySchema = Schema.Struct({
  memberType: Schema.String,
  serverRevisionCounter: Schema.Number,
  lastRetrievedFromServer: Schema.optional(Schema.Number.pipe(Schema.NullOr)),
  isNameObsolete: Schema.Boolean,
});
export type MemberRevisionLegacy = Schema.Schema.Type<typeof MemberRevisionLegacySchema>;

export const ContentsV1Schema = Schema.Struct({
  fileVersion: Schema.Literal(1),
  serverMaxRevisionCounter: Schema.Number,
  sourceMembers: Schema.Record(Schema.String, MemberRevisionSchema),
});
export type ContentsV1 = Schema.Schema.Type<typeof ContentsV1Schema>;

export const ContentsV0Schema = Schema.Struct({
  fileVersion: Schema.optional(Schema.Literal(0)),
  serverMaxRevisionCounter: Schema.Number,
  sourceMembers: Schema.Record(Schema.String, MemberRevisionLegacySchema),
});
export type ContentsV0 = Schema.Schema.Type<typeof ContentsV0Schema>;

/** JSON codec shared by reads and writes of both tracking-file formats. */
export const ContentsJsonSchema = Schema.fromJsonString(Schema.Union([ContentsV1Schema, ContentsV0Schema]), {
  space: 4,
});

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
