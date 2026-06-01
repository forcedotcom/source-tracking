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
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { parseIndexV2, readIndex } from '../../../src/git/indexV2';
import { IndexCorruptError } from '../../../src/git/errors';

const FixtureRoot = path.join(__dirname, '..', '..', 'git', 'fixtures');
const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const run = <A, E>(eff: Effect.Effect<A, E, FileSystem | Path>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.provide(eff, Layered));

describe('git/indexV2 (phase 6)', () => {
  it('parses the single-file/ fixture index (1 entry)', async () => {
    const exit = await run(readIndex(path.join(FixtureRoot, 'single-file', 'dot-git')));
    expect(Exit.isSuccess(exit)).to.equal(true);
    if (Exit.isSuccess(exit)) {
      const idx = exit.value;
      expect(idx.entries.length).to.equal(1);
      const e = idx.entries[0];
      expect(e.path).to.equal('hello.txt');
      expect(e.stage).to.equal(0);
      expect(e.oid).to.equal('ce013625030ba8dba906f756967f9e9ca394464a');
      expect(e.mode).to.equal(0o10_0644);
      expect(e.assumeValid).to.equal(false);
    }
  });

  it('parses the nested-dirs/ fixture index (mixed file modes)', async () => {
    const exit = await run(readIndex(path.join(FixtureRoot, 'nested-dirs', 'dot-git')));
    expect(Exit.isSuccess(exit)).to.equal(true);
    if (Exit.isSuccess(exit)) {
      const idx = exit.value;
      const paths = idx.entries.map((e) => e.path).sort();
      expect(paths).to.deep.equal(['a/b/plain.txt', 'a/b/run.sh', 'a/link-to-plain', 'c/two.txt']);
      // run.sh is mode 100755
      const runEntry = idx.entries.find((e) => e.path === 'a/b/run.sh');
      expect(runEntry?.mode).to.equal(0o10_0755);
      // link-to-plain is mode 120000 (symlink)
      const link = idx.entries.find((e) => e.path === 'a/link-to-plain');
      expect(link?.mode).to.equal(0o12_0000);
    }
  });

  it('captures TREE extension on nested-dirs/ for round-trip', async () => {
    const exit = await run(readIndex(path.join(FixtureRoot, 'nested-dirs', 'dot-git')));
    if (Exit.isSuccess(exit)) {
      const treeExt = exit.value.extensions.find((e) => e.signature === 'TREE');
      expect(treeExt, 'TREE extension').to.not.equal(undefined);
    }
  });

  it('captures UNTR extension on with-untr/', async () => {
    const exit = await run(readIndex(path.join(FixtureRoot, 'with-untr', 'dot-git')));
    if (Exit.isSuccess(exit)) {
      const untr = exit.value.extensions.find((e) => e.signature === 'UNTR');
      expect(untr, 'UNTR extension').to.not.equal(undefined);
      expect(untr!.payload.byteLength).to.be.greaterThan(0);
    }
  });

  it('rejects v3 with IndexCorruptError', async () => {
    // synthesize a v3 header
    const v3 = new Uint8Array(32);
    new DataView(v3.buffer).setUint32(0, 0x44_49_52_43, false); // DIRC
    new DataView(v3.buffer).setUint32(4, 3, false); // version 3
    const exit = await run(parseIndexV2('test-gitdir', v3));
    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      const fail = Cause.failureOption(exit.cause);
      if (Option.isSome(fail)) expect(fail.value).to.be.instanceOf(IndexCorruptError);
    }
  });

  it('rejects malformed (too-short) buffer', async () => {
    const exit = await run(parseIndexV2('test-gitdir', new Uint8Array(8)));
    expect(Exit.isFailure(exit)).to.equal(true);
  });

  it('readIndex on a missing file → empty IndexV2', async () => {
    const tmp = await fs.mkdtemp(path.join(__dirname, 'tmp-'));
    try {
      const exit = await run(readIndex(tmp));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.entries).to.deep.equal([]);
        expect(exit.value.entriesByteLength).to.equal(0);
        expect(exit.value.extensions).to.deep.equal([]);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
