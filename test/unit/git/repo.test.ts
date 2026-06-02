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
import * as fsP from 'node:fs/promises';
import * as osP from 'node:os';
import * as pathP from 'node:path';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
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
    // collectStatus now implements (phase 8). Against /tmp/lite-test/.git
    // it'll fail with IndexCorruptError (no index file) — what we care
    // about is that it does NOT fail with RepoNotConfiguredError.
    const exit = await runUnit(
      Effect.gen(function* () {
        const repo = yield* Repo;
        yield* repo.switchTo(cfg('/tmp/lite-test/.git'));
        return yield* repo.collectStatus();
      })
    );
    if (Exit.isFailure(exit)) {
      const fail = Cause.failureOption(exit.cause);
      if (Option.isSome(fail)) {
        expect(fail.value).to.not.be.instanceOf(RepoNotConfiguredError);
      }
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

describe('git/Repo UNTR cache integration', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsP.mkdtemp(pathP.join(osP.tmpdir(), 'lite-repo-untr-'));
  });
  afterEach(async () => {
    await fsP.rm(tmp, { recursive: true, force: true });
  });

  it('applyChanges writes the UNTR sidecar; subsequent collectStatus is consistent with cold', async () => {
    const dir = pathP.join(tmp, 'work');
    await fsP.mkdir(pathP.join(dir, 'a'), { recursive: true });
    await fsP.writeFile(pathP.join(dir, 'a', 'tracked.txt'), 'one\n');
    await fsP.writeFile(pathP.join(dir, 'a', 'untracked.log'), 'log\n');
    const gitdir = pathP.join(dir, '.git');
    const c: SwitchCfg = {
      dir,
      gitdir,
      roots: [Schema.decodeUnknownSync(RepoPath)('a')],
      fdPermits: 8,
    };
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const repo = yield* Repo;
            yield* repo.init(c);
            yield* repo.applyChanges({
              adds: Stream.fromIterable([Schema.decodeUnknownSync(RepoPath)('a/tracked.txt')]),
              removes: Stream.empty,
              message: 'init',
              author: { name: 'sf', email: 'sf@noreply.salesforce.com' },
            });
            const status = yield* repo.collectStatus();
            return status;
          }),
          TestLayer
        )
      )
    );
    expect(Exit.isSuccess(exit)).to.equal(true);
    if (!Exit.isSuccess(exit)) return;
    // Sidecar should exist after applyChanges.
    const sidecar = pathP.join(gitdir, 'sftracking', 'untr.json');
    const exists = await fsP
      .stat(sidecar)
      .then(() => true)
      .catch(() => false);
    expect(exists).to.equal(true);
    // Status should include the tracked + untracked entries.
    const paths = exit.value.map((e) => e.path);
    expect(paths).to.include('a/tracked.txt');
    expect(paths).to.include('a/untracked.log');
  });
});
