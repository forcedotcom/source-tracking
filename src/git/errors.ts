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
import * as Schema from 'effect/Schema';
import { type PlatformError } from '@effect/platform/Error';
import { Oid, RefName } from './schemas';

// every operation called before any switchTo
export class RepoNotConfiguredError extends Schema.TaggedError<RepoNotConfiguredError>()('RepoNotConfiguredError', {
  message: Schema.String,
}) {}

// partial/torn .git/ state, malformed index v2, or init over a partial shadow
export class IndexCorruptError extends Schema.TaggedError<IndexCorruptError>()('IndexCorruptError', {
  gitdir: Schema.String,
  reason: Schema.String,
  message: Schema.String,
}) {}

export class ObjectNotFoundError extends Schema.TaggedError<ObjectNotFoundError>()('ObjectNotFoundError', {
  oid: Oid,
  message: Schema.String,
}) {}

export class ObjectCorruptError extends Schema.TaggedError<ObjectCorruptError>()('ObjectCorruptError', {
  oid: Oid,
  reason: Schema.String,
  message: Schema.String,
}) {}

// catches every PlatformError at the lite boundary. Emitted as a warning by
// statusMatrix and as a failure elsewhere.
export class WorkdirIoError extends Schema.TaggedError<WorkdirIoError>()('WorkdirIoError', {
  path: Schema.String,
  // The raw PlatformError from @effect/platform. Source-tracking never sees
  // it directly; mapping happens via catchTags.
  cause: Schema.Defect,
  message: Schema.String,
}) {
  public static fromPlatformError(path: string, cause: PlatformError): WorkdirIoError {
    return new WorkdirIoError({ path, cause, message: `${path}: ${cause.message}` });
  }
}

export class RepoLockedError extends Schema.TaggedError<RepoLockedError>()('RepoLockedError', {
  lockPath: Schema.String,
  ageMs: Schema.Number,
  ageHumanReadable: Schema.String,
  message: Schema.String,
}) {}

// caller-side programmer error: path outside roots, bad branding, etc.
export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()('InvalidPathError', {
  path: Schema.String,
  reason: Schema.String,
  message: Schema.String,
}) {}

export class RefNotFoundError extends Schema.TaggedError<RefNotFoundError>()('RefNotFoundError', {
  ref: RefName,
  message: Schema.String,
}) {}

// closed-set error type used in catchTags by source-tracking's
// redirectToCliRepoError replacement.
export type RepoError =
  | RepoNotConfiguredError
  | IndexCorruptError
  | ObjectNotFoundError
  | ObjectCorruptError
  | WorkdirIoError
  | RepoLockedError
  | InvalidPathError
  | RefNotFoundError;
