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
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { IndexCorruptError, type WorkdirIoError } from './errors';
import { readIndex } from './indexV2';
import { readDirectRef, readHead } from './refs';
import { RefName } from './schemas';

const ENV_FLAG = 'SF_SOURCE_TRACKING_INTEGRITY_CHECK';

/**
 * Optional startup integrity check, gated by SF_SOURCE_TRACKING_INTEGRITY_CHECK
 * during the dogfood window per phase 13. Verifies that .git/HEAD parses
 * and points at refs/heads/main, that refs/heads/main resolves to a 40-hex
 * oid, and that .git/index parses as v2 (parseIndexV2 reaching the end
 * without throwing is the proxy for trailing-sha1 verification).
 *
 * Run by source-tracking on first ShadowRepo construction when the flag
 * is set. Fails closed with IndexCorruptError so the caller can prompt the
 * user to delete + re-init the shadow.
 */
export const isEnabled = (): boolean => process.env[ENV_FLAG] === 'true';

const MAIN_REF: RefName = Schema.decodeUnknownSync(RefName)('refs/heads/main');

export const runIntegrityCheck = (
  gitdir: string
): Effect.Effect<void, IndexCorruptError | WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const head = yield* readHead(gitdir).pipe(
      Effect.catchTag('RefNotFoundError', (cause) =>
        Effect.fail(
          new IndexCorruptError({
            gitdir,
            reason: 'head-missing',
            message: `integrity check: HEAD not found (${cause.message})`,
          })
        )
      )
    );
    if (head.kind !== 'symbolic' || head.target !== MAIN_REF) {
      return yield* Effect.fail(
        new IndexCorruptError({
          gitdir,
          reason: 'head-not-symbolic-main',
          message: `integrity check: HEAD is ${
            head.kind === 'symbolic' ? `symbolic to ${head.target}` : 'detached'
          }, expected refs/heads/main`,
        })
      );
    }
    yield* readDirectRef(gitdir, MAIN_REF).pipe(
      Effect.catchTag('RefNotFoundError', (cause) =>
        Effect.fail(
          new IndexCorruptError({
            gitdir,
            reason: 'main-missing',
            message: `integrity check: refs/heads/main not found (${cause.message})`,
          })
        )
      )
    );
    yield* readIndex(gitdir).pipe(
      Effect.catchTag('IndexCorruptError', (cause) =>
        Effect.fail(
          new IndexCorruptError({
            gitdir,
            reason: 'index-corrupt',
            message: `integrity check: ${cause.message}`,
          })
        )
      )
    );
  });
