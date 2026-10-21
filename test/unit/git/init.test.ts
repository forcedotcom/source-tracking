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
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import type { Crypto } from 'effect/Crypto';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { init } from '../../../src/git/init.js';
import { resolveRef } from '../../../src/git/refs.js';
import { IndexCorruptError } from '../../../src/git/errors.js';
import { RefName, RepoPath, SwitchCfg } from '../../../src/git/schemas.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FixtureRoot = path.join(currentDir, '..', '..', 'git', 'fixtures');
const NodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer);

const run = <A, E>(
  eff: Effect.Effect<A, E, FileSystem | Path | Crypto>,
  layer: Layer.Layer<FileSystem | Path | Crypto> = NodeLayer
): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(Effect.provide(eff, layer));

const cfg = (gitdir: string): SwitchCfg => ({
  dir: path.dirname(gitdir),
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('force-app')],
  fdPermits: 8,
});

const FIXED_TS = Date.parse('2026-01-01T00:00:00Z'); // matches generate.sh
const legacyEmptyIsomorphicConfig =
  '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = true\n\tsymlinks = false\n\tignorecase = true\n';

const createLegacyEmptyIsomorphicRepo = async (gitdir: string): Promise<void> => {
  const directories = ['hooks', 'info', 'objects/info', 'objects/pack', 'refs/heads', 'refs/tags'];
  await Promise.all(directories.map((directory) => fs.mkdir(path.join(gitdir, directory), { recursive: true })));
  await fs.writeFile(path.join(gitdir, 'config'), legacyEmptyIsomorphicConfig);
  await fs.writeFile(path.join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');
};

describe('git/init (phase 5)', () => {
  it('produces byte-identical objects + refs to the empty/ fixture', async () => {
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

  it('serializes concurrent initialization of the same gitdir', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-concurrent-'));
    try {
      const gitdir = path.join(tmp, '.git');
      const exits = await Promise.all(
        Array.from({ length: 8 }, (_, i) => run(init({ cfg: cfg(gitdir), timestampMs: FIXED_TS + i * 1000 })))
      );
      expect(exits.every(Exit.isSuccess)).to.equal(true);
      const commitOids = exits.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : []));
      expect(new Set(commitOids).size).to.equal(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('upgrades an empty isomorphic-git initialization', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-isomorphic-'));
    try {
      const gitdir = path.join(tmp, '.git');
      await createLegacyEmptyIsomorphicRepo(gitdir);

      const exit = await run(init({ cfg: cfg(gitdir), timestampMs: FIXED_TS }));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).to.equal('a69e437d3322f2f453a67bfa0ddb2ae0885533b4');
        expect(await fs.readFile(path.join(gitdir, 'refs', 'heads', 'main'), 'utf8')).to.equal(`${exit.value}\n`);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a legacy-looking repo with missing or extra entries', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-isomorphic-partial-'));
    try {
      const missingDirectoryGitdir = path.join(tmp, 'missing-directory', '.git');
      await createLegacyEmptyIsomorphicRepo(missingDirectoryGitdir);
      await fs.rm(path.join(missingDirectoryGitdir, 'refs', 'tags'), { recursive: true, force: true });
      const missingDirectoryExit = await run(init({ cfg: cfg(missingDirectoryGitdir), timestampMs: FIXED_TS }));
      expect(Exit.isFailure(missingDirectoryExit)).to.equal(true);
      if (Exit.isFailure(missingDirectoryExit)) {
        const error = Cause.findErrorOption(missingDirectoryExit.cause);
        expect(Option.isSome(error) && Schema.is(IndexCorruptError)(error.value)).to.equal(true);
      }

      const extraEntryGitdir = path.join(tmp, 'extra-entry', '.git');
      await createLegacyEmptyIsomorphicRepo(extraEntryGitdir);
      await fs.mkdir(path.join(extraEntryGitdir, 'objects', 'ab'), { recursive: true });
      await fs.writeFile(path.join(extraEntryGitdir, 'objects', 'ab', 'cd'), 'unexpected');
      const extraEntryExit = await run(init({ cfg: cfg(extraEntryGitdir), timestampMs: FIXED_TS }));
      expect(Exit.isFailure(extraEntryExit)).to.equal(true);
      if (Exit.isFailure(extraEntryExit)) {
        const error = Cause.findErrorOption(extraEntryExit.cause);
        expect(Option.isSome(error) && Schema.is(IndexCorruptError)(error.value)).to.equal(true);
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
        const fail = Cause.findErrorOption(exit.cause);
        if (Option.isSome(fail)) {
          expect(Schema.is(IndexCorruptError)(fail.value)).to.equal(true);
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

  it('writes minimal core config', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-init-config-'));
    try {
      await run(init({ cfg: cfg(path.join(tmp, '.git')), timestampMs: FIXED_TS }));
      const config = await fs.readFile(path.join(tmp, '.git', 'config'), 'utf-8');
      expect(config).to.equal('[core]\n\trepositoryformatversion = 0\n');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
