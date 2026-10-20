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
import { access, appendFile } from 'node:fs/promises';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { isNotUndefined } from 'effect/Predicate';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { withIndexLock } from '../../../src/git/lock.js';

const role = process.env.LOCK_TEST_ROLE;
const gitdir = process.env.LOCK_TEST_GITDIR;
const logPath = process.env.LOCK_TEST_LOG;
const holdMs = Number(process.env.LOCK_TEST_HOLD_MS ?? '0');
const releaseSignal = process.env.LOCK_TEST_RELEASE_SIGNAL;

if (!isNotUndefined(role) || !isNotUndefined(gitdir) || !isNotUndefined(logPath)) {
  throw new Error('lock worker requires role, gitdir, and log path');
}

const action = withIndexLock(gitdir)(
  Effect.gen(function* () {
    yield* Effect.promise(() => appendFile(logPath, `${role}:start\n`));
    if (role === 'first' && isNotUndefined(releaseSignal) && releaseSignal !== '') {
      yield* Effect.sync(() => process.stdout.write(`${role}-acquired\n`));
      let released = false;
      while (!released) {
        released = yield* Effect.promise(() =>
          access(releaseSignal).then(
            () => true,
            () => false
          )
        );
        if (!released) yield* Effect.sleep('20 millis');
      }
    } else if (holdMs > 0) {
      yield* Effect.sync(() => process.stdout.write(`${role}-acquired\n`));
      yield* Effect.sleep(holdMs);
    }
    yield* Effect.promise(() => appendFile(logPath, `${role}:end\n`));
  })
);

if (role === 'second') process.stdout.write('second-attempting\n');
await Effect.runPromise(Effect.provide(action, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));
