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
import type { PlatformError } from 'effect/PlatformError';
import { Oid, RefName } from './schemas.js';

// partial/torn .git/ state, malformed index v2, or init over a partial shadow
/** @internal */
export class IndexCorruptError extends Schema.TaggedError<IndexCorruptError>()('IndexCorruptError', {
  gitdir: Schema.String,
  reason: Schema.String,
  message: Schema.String,
}) {}

/** @internal */
export class ObjectNotFoundError extends Schema.TaggedError<ObjectNotFoundError>()('ObjectNotFoundError', {
  oid: Oid,
  message: Schema.String,
}) {}

/** @internal */
export class ObjectCorruptError extends Schema.TaggedError<ObjectCorruptError>()('ObjectCorruptError', {
  oid: Oid,
  reason: Schema.String,
  message: Schema.String,
}) {}

/** @internal */
export class RepoLockedError extends Schema.TaggedError<RepoLockedError>()('RepoLockedError', {
  lockPath: Schema.String,
  ageMs: Schema.Number,
  ageHumanReadable: Schema.String,
  message: Schema.String,
}) {}

/** @internal */
export class RefNotFoundError extends Schema.TaggedError<RefNotFoundError>()('RefNotFoundError', {
  ref: RefName,
  message: Schema.String,
}) {}

// Closed-set error type mapped to SfError at the source-tracking boundary.
/** @internal */
export type RepoError =
  | IndexCorruptError
  | ObjectNotFoundError
  | ObjectCorruptError
  | PlatformError
  | RepoLockedError
  | RefNotFoundError;
