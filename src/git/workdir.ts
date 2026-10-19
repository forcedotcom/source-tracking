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

import * as nodeFs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as nodePath from 'node:path';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { systemError, type SystemErrorTag } from 'effect/PlatformError';

const NodeErrnoError = Schema.Struct({
  code: Schema.optional(Schema.String),
  syscall: Schema.optional(Schema.String),
});

const nodeErrorTag = (code?: string): SystemErrorTag =>
  Match.value(code).pipe(
    Match.whenOr('ENOENT', 'ENOTDIR', (): SystemErrorTag => 'NotFound'),
    Match.whenOr('EACCES', 'EPERM', (): SystemErrorTag => 'PermissionDenied'),
    Match.when('EEXIST', (): SystemErrorTag => 'AlreadyExists'),
    Match.when('EBUSY', (): SystemErrorTag => 'Busy'),
    Match.when('ETIMEDOUT', (): SystemErrorTag => 'TimedOut'),
    Match.when('EINVAL', (): SystemErrorTag => 'InvalidData'),
    Match.orElse((): SystemErrorTag => 'Unknown')
  );

/** lstat differs from FileSystem.stat, which follows symlinks. */
export const lstat = Effect.fnUntraced(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => nodeFs.lstat(path),
    catch: (cause) => {
      const error = Option.getOrUndefined(Schema.decodeUnknownOption(NodeErrnoError)(cause));
      return systemError({
        _tag: nodeErrorTag(error?.code),
        module: 'FileSystem',
        method: 'lstat',
        description: cause instanceof Error ? cause.message : String(cause),
        syscall: error?.syscall,
        pathOrDescriptor: path,
        cause,
      });
    },
  });
});

export const GIT_FILE_MODE = 0o10_0644;
export const GIT_EXECUTABLE_MODE = 0o10_0755;
export const GIT_SYMLINK_MODE = 0o12_0000;

export const gitModeFromStat = (info: Stats): number =>
  info.isSymbolicLink() ? GIT_SYMLINK_MODE : info.mode & 0o111 ? GIT_EXECUTABLE_MODE : GIT_FILE_MODE;

/**
 * Convert a native symlink target to Git's slash-separated blob bytes.
 *
 * @internal
 */
export const normalizeGitSymlinkTarget = (target: string, separator = nodePath.sep): string =>
  separator === '/' ? target : target.split(separator).join('/');

export const isSymlinkMode = (mode: number): boolean => (mode & 0o17_0000) === GIT_SYMLINK_MODE;
