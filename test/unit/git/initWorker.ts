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
import path from 'node:path';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { FileSystem } from 'effect/FileSystem';
import { init } from '../../../src/git/init.js';
import { RepoPath } from '../../../src/git/schemas.js';

const gitdir = process.argv[2];
if (!gitdir) throw new Error('init worker requires a gitdir');

const pause = Effect.callback<void>((resume) => {
  const release = () => resume(Effect.void);
  process.once('message', release);
  process.send?.('paused');
  return Effect.sync(() => process.off('message', release));
});

process.send?.('starting');
await Effect.gen(function* () {
  const fs = yield* FileSystem;
  return yield* init({
    cfg: {
      dir: path.dirname(gitdir),
      gitdir,
      roots: [Schema.decodeUnknownSync(RepoPath)('force-app')],
      fdPermits: 8,
    },
  }).pipe(
    // Hold the first process between publishing main and HEAD.
    Effect.provideService(FileSystem, {
      ...fs,
      rename: (from, to) =>
        fs
          .rename(from, to)
          .pipe(
            Effect.andThen(() =>
              process.argv[3] === 'pause' && to === path.join(gitdir, 'refs', 'heads', 'main') ? pause : Effect.void
            )
          ),
    })
  );
})
  .pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)), Effect.runPromise)
  .then(
    (oid) => process.stdout.write(oid),
    (error: Error) => {
      process.stderr.write(error.message);
      process.exitCode = 1;
    }
  );
process.disconnect?.();
