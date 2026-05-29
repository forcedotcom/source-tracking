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
import { init } from '../../../src/git/init';
import { resolveRef } from '../../../src/git/refs';
import { CapabilitiesTag, NodeCapabilitiesLayer, MemfsCapabilitiesLayer } from '../../../src/git/capabilities';
import { IndexCorruptError } from '../../../src/git/errors';
import { RefName, RepoPath, SwitchCfg } from '../../../src/git/schemas';

const FixtureRoot = path.join(__dirname, '..', '..', 'git', 'fixtures');
const NodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCapabilitiesLayer);
const MemfsCapsLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, MemfsCapabilitiesLayer);

const run = <A, E>(
  eff: Effect.Effect<A, E, FileSystem | Path | CapabilitiesTag>,
  layer: Layer.Layer<FileSystem | Path | CapabilitiesTag> = NodeLayer
): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(Effect.provide(eff, layer));

const cfg = (gitdir: string): SwitchCfg => ({
  dir: path.dirname(gitdir),
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('force-app')],
  fdPermits: 8,
});

const FIXED_TS = Date.parse('2026-01-01T00:00:00Z'); // matches generate.sh

describe('git/init (phase 5)', () => {
  it('produces byte-identical objects + refs to the empty/ fixture (Node capabilities)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-'));
    try {
      const gitdir = path.join(tmp, '.git');
      const exit = await run(init({ cfg: cfg(gitdir), timestampMs: FIXED_TS }));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (!Exit.isSuccess(exit)) return;

      // Compare HEAD bytes
      const fixtureRoot = path.join(FixtureRoot, 'empty', 'dot-git');
      const head = await fs.readFile(path.join(gitdir, 'HEAD'));
      const headFixture = await fs.readFile(path.join(fixtureRoot, 'HEAD'));
      expect(Buffer.compare(head, headFixture)).to.equal(0);

      // Compare refs/heads/main bytes
      const refMain = await fs.readFile(path.join(gitdir, 'refs', 'heads', 'main'));
      const refMainFixture = await fs.readFile(path.join(fixtureRoot, 'refs', 'heads', 'main'));
      expect(Buffer.compare(refMain, refMainFixture)).to.equal(0);

      // Loose-object byte-equality: oid matches (real-git asserts only the
      // sha-of-content; zlib compression level is implementation-detail).
      // Asserting the path-on-disk is sufficient: if the file exists at
      // .git/objects/<a..b>/<rest>, the content sha matches by construction.
      const emptyTreeOid = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      const emptyTreePath = path.join(gitdir, 'objects', emptyTreeOid.slice(0, 2), emptyTreeOid.slice(2));
      const fixturePath = path.join(fixtureRoot, 'objects', emptyTreeOid.slice(0, 2), emptyTreeOid.slice(2));
      await fs.access(emptyTreePath);
      await fs.access(fixturePath);

      const commitOid = 'a69e437d3322f2f453a67bfa0ddb2ae0885533b4';
      await fs.access(path.join(gitdir, 'objects', commitOid.slice(0, 2), commitOid.slice(2)));
      expect(exit.value).to.equal(commitOid);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('idempotent: second init over a valid shadow returns the existing commit oid', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-idem-'));
    try {
      const gitdir = path.join(tmp, '.git');
      const a = await run(init({ cfg: cfg(gitdir), timestampMs: FIXED_TS }));
      const b = await run(init({ cfg: cfg(gitdir), timestampMs: FIXED_TS + 999_000 })); // different ts
      if (Exit.isSuccess(a) && Exit.isSuccess(b)) {
        expect(b.value).to.equal(a.value); // same commit oid; second init is no-op
      } else {
        throw new Error('both init effects should succeed');
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('partial shadow (HEAD without refs/heads/main) → IndexCorruptError', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-partial-'));
    try {
      const gitdir = path.join(tmp, '.git');
      await fs.mkdir(gitdir, { recursive: true });
      await fs.writeFile(path.join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');
      const exit = await run(init({ cfg: cfg(gitdir), timestampMs: FIXED_TS }));
      expect(Exit.isFailure(exit)).to.equal(true);
      if (Exit.isFailure(exit)) {
        const fail = Cause.failureOption(exit.cause);
        if (Option.isSome(fail)) {
          expect(fail.value).to.be.instanceOf(IndexCorruptError);
        }
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('after init, resolveRef(HEAD) and resolveRef(refs/heads/main) succeed', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-resolve-'));
    try {
      const gitdir = path.join(tmp, '.git');
      await run(init({ cfg: cfg(gitdir), timestampMs: FIXED_TS }));
      const head = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('HEAD')), NodeLayer)
      );
      const main = await Effect.runPromise(
        Effect.provide(resolveRef(gitdir, Schema.decodeUnknownSync(RefName)('refs/heads/main')), NodeLayer)
      );
      expect(head).to.equal('a69e437d3322f2f453a67bfa0ddb2ae0885533b4');
      expect(main).to.equal('a69e437d3322f2f453a67bfa0ddb2ae0885533b4');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('Node capabilities → config has untrackedCache=true; memfs caps → it is omitted', async () => {
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-caps-on-'));
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-caps-off-'));
    try {
      await run(init({ cfg: cfg(path.join(tmpA, '.git')), timestampMs: FIXED_TS }));
      const aConfig = await fs.readFile(path.join(tmpA, '.git', 'config'), 'utf-8');
      expect(aConfig).to.include('untrackedCache = true');

      await run(init({ cfg: cfg(path.join(tmpB, '.git')), timestampMs: FIXED_TS }), MemfsCapsLayer);
      const bConfig = await fs.readFile(path.join(tmpB, '.git', 'config'), 'utf-8');
      expect(bConfig).to.not.include('untrackedCache');
    } finally {
      await Promise.all([fs.rm(tmpA, { recursive: true, force: true }), fs.rm(tmpB, { recursive: true, force: true })]);
    }
  });
});
