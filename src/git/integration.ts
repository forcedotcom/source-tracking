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
import {
  IndexCorruptError,
  InvalidPathError,
  ObjectCorruptError,
  ObjectNotFoundError,
  RefNotFoundError,
  type RepoError,
  RepoLockedError,
  RepoNotConfiguredError,
  WorkdirIoError,
} from './errors';

/**
 * Read once per process at the ShadowRepo constructor — no mid-process
 * flipping. CLI invocations are short-lived; VSCode reads on activation
 * (a reload-window is required to flip).
 */
export const useLiteGit = (): boolean => process.env.SF_SOURCE_TRACKING_USE_LITE_GIT === 'true';

/**
 * Map a lite RepoError to an SfError with a stable name. Source-tracking's
 * existing redirectToCliRepoError catch site is sync, so we expose this as
 * a plain function. When source-tracking integrates lite per-call inside
 * Effect chains, mirror this with `Effect.catchTags(...)` directly there;
 * the names below match the keys in messages/sourceTracking.md.
 */
export const repoErrorToSfError = (e: RepoError): SfError => {
  if (e instanceof RepoLockedError) {
    return new SfError(
      `repoLocked: ${e.lockPath} (held ${e.ageHumanReadable}); remove the lockfile manually if no other process is active`,
      'repoLocked'
    );
  }
  if (e instanceof IndexCorruptError) return new SfError(`indexCorrupt: ${e.gitdir} (${e.reason})`, 'indexCorrupt');
  if (e instanceof ObjectNotFoundError) return new SfError(`objectNotFound: ${e.oid}`, 'objectNotFound');
  if (e instanceof ObjectCorruptError) return new SfError(`objectCorrupt: ${e.oid} (${e.reason})`, 'objectCorrupt');
  if (e instanceof RepoNotConfiguredError) return new SfError(`repoNotConfigured: ${e.message}`, 'repoNotConfigured');
  if (e instanceof WorkdirIoError) return new SfError(`workdirIo: ${e.path}: ${e.message}`, 'workdirIo');
  if (e instanceof InvalidPathError) return new SfError(`invalidPath: ${e.path} (${e.reason})`, 'invalidPath');
  if (e instanceof RefNotFoundError) return new SfError(`refNotFound: ${e.ref}`, 'refNotFound');
  return new SfError('unknown lite repo error', 'unknownRepoError');
};
