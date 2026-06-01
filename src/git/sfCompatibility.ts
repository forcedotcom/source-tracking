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
import { SfError } from '@salesforce/core';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import { type RepoError } from './errors';

/**
 * Whether the SF_SOURCE_TRACKING_USE_LITE_GIT env var opts in to lite.
 * Resolved through Effect's `Config` so tests can inject via ConfigProvider
 * instead of mutating process.env. Source-tracking yields this once at the
 * ShadowRepo constructor — CLI invocations are short-lived, and VSCode
 * reads it on activation (reload-window to flip).
 */
export const useLiteGit = Config.boolean('SF_SOURCE_TRACKING_USE_LITE_GIT').pipe(
  Config.withDefault(false),
  Effect.orDie
);

/**
 * Map a RepoError to an SfError with a stable name. Each arm builds an
 * SfError whose `name` matches a key in `messages/sourceTracking.md`.
 *
 * Used by source-tracking's existing `redirectToCliRepoError`-shaped sync
 * catch site. When phase 12 wires source-tracking call sites into lite's
 * Effect API, the pipe-able form is one line:
 * `someEffect.pipe(Effect.mapError(repoErrorToSfError))`. No need to
 * export a separate combinator until a caller actually needs it.
 */
export const repoErrorToSfError: (e: RepoError) => SfError = Match.type<RepoError>().pipe(
  Match.tagsExhaustive({
    RepoLockedError: (e) =>
      new SfError(
        `repoLocked: ${e.lockPath} (held ${e.ageHumanReadable}); remove the lockfile manually if no other process is active`,
        'repoLocked'
      ),
    IndexCorruptError: (e) => new SfError(`indexCorrupt: ${e.gitdir} (${e.reason})`, 'indexCorrupt'),
    ObjectNotFoundError: (e) => new SfError(`objectNotFound: ${e.oid}`, 'objectNotFound'),
    ObjectCorruptError: (e) => new SfError(`objectCorrupt: ${e.oid} (${e.reason})`, 'objectCorrupt'),
    RepoNotConfiguredError: (e) => new SfError(`repoNotConfigured: ${e.message}`, 'repoNotConfigured'),
    WorkdirIoError: (e) => new SfError(`workdirIo: ${e.path}: ${e.message}`, 'workdirIo'),
    RefNotFoundError: (e) => new SfError(`refNotFound: ${e.ref}`, 'refNotFound'),
  })
);
