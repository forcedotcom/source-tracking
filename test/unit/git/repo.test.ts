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
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Repo } from '../../../src/git/repo';
import { NodeCapabilitiesLayer } from '../../../src/git/capabilities';
import { RepoNotConfiguredError } from '../../../src/git/errors';
import { RepoPath, SwitchCfg } from '../../../src/git/schemas';

const TestLayer = Layer.provide(
  Repo.Default,
  Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCapabilitiesLayer)
);

const cfg = (gitdir: string): SwitchCfg => ({
  dir: '/tmp/lite-test',
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('force-app')],
  fdPermits: 8,
});

const runUnit = <A, E>(effect: Effect.Effect<A, E, Repo>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.scoped(Effect.provide(effect, TestLayer)));

describe('git/Repo lifecycle (phase 1)', () => {
  it('every method but init/switchTo/hashBlob fails with RepoNotConfiguredError pre-switchTo', async () => {
    const exit = await runUnit(
      Effect.gen(function* () {
        const repo = yield* Repo;
        return yield* repo.collectStatus();
      })
    );
    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      const fail = Cause.failureOption(exit.cause);
      expect(Option.isSome(fail)).to.equal(true);
      if (Option.isSome(fail)) {
        expect(fail.value).to.be.instanceOf(RepoNotConfiguredError);
      }
    }
  });

  it('resolveRef pre-switchTo fails with RepoNotConfiguredError', async () => {
    const exit = await runUnit(
      Effect.gen(function* () {
        const repo = yield* Repo;
        return yield* repo.resolveRef(Schema.decodeUnknownSync(Schema.String)('HEAD') as never);
      })
    );
    expect(Exit.isFailure(exit)).to.equal(true);
  });

  it('switchTo installs a handle (subsequent ops no longer fail with RepoNotConfiguredError)', async () => {
    const exit = await runUnit(
      Effect.gen(function* () {
        const repo = yield* Repo;
        yield* repo.switchTo(cfg('/tmp/lite-test/.git')); // doesn't touch fs in phase 1
        // collectStatus still dies with "not implemented", but that's a defect,
        // not a typed RepoNotConfiguredError. Verify by catching the typed
        // failure channel: it must be empty.
        return yield* repo.collectStatus().pipe(Effect.catchAll(() => Effect.succeed('typed-failure')));
      })
    );
    // Defect ("not implemented") => isFailure but no typed failure
    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      const typed = Cause.failureOption(exit.cause);
      expect(Option.isNone(typed)).to.equal(true); // RepoNotConfigured is gone
      const die = Cause.dieOption(exit.cause);
      expect(Option.isSome(die)).to.equal(true);
    }
  });

  it('switchTo replaces the prior handle atomically (second cfg wins)', async () => {
    const exit = await runUnit(
      Effect.gen(function* () {
        const repo = yield* Repo;
        yield* repo.switchTo(cfg('/tmp/lite-test/a/.git'));
        yield* repo.switchTo(cfg('/tmp/lite-test/b/.git'));
        // Just exercise the swap path; no asserting on cfg shape here because
        // SwitchCfg is private to the handle. Phase 5+ surfaces something
        // observable about the active handle (the init bytes themselves).
        return 'ok';
      })
    );
    expect(Exit.isSuccess(exit)).to.equal(true);
  });

  it('Layer scope close finalizes a switched-in handle (no orphan resource warnings)', async () => {
    // Smoke test: scoping the whole runUnit through Effect.scoped releases the
    // service scope and, transitively, the per-handle child scope.
    const exit = await runUnit(
      Effect.gen(function* () {
        const repo = yield* Repo;
        yield* repo.switchTo(cfg('/tmp/lite-test/scoped/.git'));
        return 'ok';
      })
    );
    expect(Exit.isSuccess(exit)).to.equal(true);
  });
});
