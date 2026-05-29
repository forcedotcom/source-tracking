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
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { readDirectRef, readHead, resolveRef, writeDirectRef, writeSymbolicHead } from '../../../src/git/refs';
import { RefName } from '../../../src/git/schemas';
import { RefNotFoundError } from '../../../src/git/errors';

const FixtureRoot = path.join(__dirname, '..', '..', 'git', 'fixtures');
const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const run = <A, E>(eff: Effect.Effect<A, E, FileSystem | Path>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.provide(eff, TestLayer));
const refOf = (s: string): RefName => Schema.decodeUnknownSync(RefName)(s);

describe('git/refs (phase 3)', () => {
  describe('readHead', () => {
    it('parses a symbolic HEAD from the empty/ fixture', async () => {
      const exit = await run(readHead(path.join(FixtureRoot, 'empty', 'dot-git')));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.kind).to.equal('symbolic');
        if (exit.value.kind === 'symbolic') {
          expect(exit.value.target).to.equal('refs/heads/main');
        }
      }
    });

    it('reports RefNotFoundError when HEAD is missing', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-refs-'));
      try {
        const exit = await run(readHead(path.join(tmp, 'no-such-gitdir')));
        expect(Exit.isFailure(exit)).to.equal(true);
        if (Exit.isFailure(exit)) {
          const fail = Cause.failureOption(exit.cause);
          expect(Option.isSome(fail)).to.equal(true);
          if (Option.isSome(fail)) {
            expect(fail.value).to.be.instanceOf(RefNotFoundError);
          }
        }
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('readDirectRef', () => {
    it('reads refs/heads/main from the empty/ fixture', async () => {
      const exit = await run(readDirectRef(path.join(FixtureRoot, 'empty', 'dot-git'), refOf('refs/heads/main')));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        // empty/ commit oid recorded by generate.sh
        expect(exit.value).to.equal('a69e437d3322f2f453a67bfa0ddb2ae0885533b4');
      }
    });

    it('reads refs/heads/main from the single-file/ fixture', async () => {
      const exit = await run(readDirectRef(path.join(FixtureRoot, 'single-file', 'dot-git'), refOf('refs/heads/main')));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).to.match(/^[0-9a-f]{40}$/);
      }
    });

    it('reports RefNotFoundError for a missing branch', async () => {
      const exit = await run(readDirectRef(path.join(FixtureRoot, 'empty', 'dot-git'), refOf('refs/heads/feature')));
      expect(Exit.isFailure(exit)).to.equal(true);
      if (Exit.isFailure(exit)) {
        const fail = Cause.failureOption(exit.cause);
        if (Option.isSome(fail)) expect(fail.value).to.be.instanceOf(RefNotFoundError);
      }
    });
  });

  describe('resolveRef', () => {
    it('HEAD → branch → oid (single hop)', async () => {
      const gitdir = path.join(FixtureRoot, 'empty', 'dot-git');
      const exit = await run(resolveRef(gitdir, refOf('HEAD')));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).to.equal('a69e437d3322f2f453a67bfa0ddb2ae0885533b4');
      }
    });

    it('refs/heads/main → oid', async () => {
      const gitdir = path.join(FixtureRoot, 'single-file', 'dot-git');
      const directExit = await run(readDirectRef(gitdir, refOf('refs/heads/main')));
      const resolveExit = await run(resolveRef(gitdir, refOf('refs/heads/main')));
      if (Exit.isSuccess(directExit) && Exit.isSuccess(resolveExit)) {
        expect(resolveExit.value).to.equal(directExit.value);
      } else {
        throw new Error('both should succeed');
      }
    });
  });

  describe('write paths', () => {
    it('writeSymbolicHead + writeDirectRef + readback round-trip', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-refs-write-'));
      try {
        const gitdir = path.join(tmp, '.git');
        await fs.mkdir(gitdir, { recursive: true });
        const oid = '0123456789abcdef0123456789abcdef01234567';
        const oidEffect = await run(writeDirectRef(gitdir, refOf('refs/heads/main'), oid as never));
        expect(Exit.isSuccess(oidEffect)).to.equal(true);
        const headEffect = await run(writeSymbolicHead(gitdir, refOf('refs/heads/main')));
        expect(Exit.isSuccess(headEffect)).to.equal(true);

        const resolved = await run(resolveRef(gitdir, refOf('HEAD')));
        if (Exit.isSuccess(resolved)) {
          expect(resolved.value).to.equal(oid);
        }

        // Verify HEAD bytes match real-git's symbolic-ref form exactly.
        const headBytes = await fs.readFile(path.join(gitdir, 'HEAD'), 'utf-8');
        expect(headBytes).to.equal('ref: refs/heads/main\n');
        const branchBytes = await fs.readFile(path.join(gitdir, 'refs', 'heads', 'main'), 'utf-8');
        expect(branchBytes).to.equal(`${oid}\n`);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
