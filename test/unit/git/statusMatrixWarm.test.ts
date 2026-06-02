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
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { applyChanges } from '../../../src/git/applyChanges';
import { CapabilitiesTag, NodeCapabilitiesLayer } from '../../../src/git/capabilities';
import { init } from '../../../src/git/init';
import { readIndex } from '../../../src/git/indexV2';
import { Author, RepoPath, type StatusEntry, type SwitchCfg } from '../../../src/git/schemas';
import { cold } from '../../../src/git/statusMatrix';
import { type WarmOutcome, warm } from '../../../src/git/statusMatrixWarm';
import { buildUntrCache, trackedByDir } from '../../../src/git/untrBuild';

const Layered = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCapabilitiesLayer);
const ALICE: Author = { name: 'sfdx source tracking', email: 'source-tracking@noreply.salesforce.com' };
const FIXED_TS = Date.parse('2026-01-01T00:00:00Z');

const repoPath = (s: string): RepoPath => Schema.decodeUnknownSync(RepoPath)(s);

const cfgFor = (dir: string, gitdir: string, roots: string[]): SwitchCfg => ({
  dir,
  gitdir,
  roots: roots.map(repoPath),
  fdPermits: 8,
});

const runWith = <A, E>(eff: Effect.Effect<A, E, FileSystem | Path | CapabilitiesTag>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, Layered));

const collectCold = (cfg: SwitchCfg): Promise<readonly StatusEntry[]> =>
  runWith(
    cold(cfg).pipe(
      Stream.runCollect,
      Effect.map((c) => Array.from(c))
    )
  );

const collectWarm = (cfg: SwitchCfg): Promise<WarmOutcome> =>
  runWith(
    Effect.gen(function* () {
      const idx = yield* readIndex(cfg.gitdir);
      const cache = yield* buildUntrCache(cfg, trackedByDir(idx.entries));
      return yield* warm(cfg, cache);
    })
  );

const sortByPath = (xs: readonly StatusEntry[]): StatusEntry[] => [...xs].sort((a, b) => a.path.localeCompare(b.path));

const seedRepo = async (prefix: string): Promise<{ tmp: string; dir: string; gitdir: string; cfg: SwitchCfg }> => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dir = path.join(tmp, 'work');
  const gitdir = path.join(dir, '.git');
  await fs.mkdir(path.join(dir, 'a'), { recursive: true });
  await fs.mkdir(path.join(dir, 'a', 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a', 'tracked.txt'), 'one\n');
  await fs.writeFile(path.join(dir, 'a', 'sub', 'nested-tracked.txt'), 'two\n');
  await fs.writeFile(path.join(dir, 'a', 'untracked.log'), 'log\n');
  await fs.writeFile(path.join(dir, 'a', 'sub', 'newfile.txt'), 'new\n');
  const cfg = cfgFor(dir, gitdir, ['a']);
  await runWith(init({ cfg, timestampMs: FIXED_TS }));
  // Stage the two files we declared "tracked".
  await runWith(
    applyChanges({
      cfg: { dir, gitdir },
      adds: Stream.fromIterable([repoPath('a/tracked.txt'), repoPath('a/sub/nested-tracked.txt')]),
      removes: Stream.empty,
      message: 'init',
      author: ALICE,
    })
  );
  return { tmp, dir, gitdir, cfg };
};

describe('git/statusMatrixWarm', () => {
  describe('functional equality with cold', () => {
    let env: { tmp: string; dir: string; gitdir: string; cfg: SwitchCfg };
    beforeEach(async () => {
      env = await seedRepo('lite-warm-eq-');
    });
    afterEach(async () => {
      await fs.rm(env.tmp, { recursive: true, force: true });
    });

    it('warm result equals cold result on an unchanged workdir', async () => {
      const coldEntries = sortByPath(await collectCold(env.cfg));
      const warmResult = await collectWarm(env.cfg);
      expect(warmResult.kind).to.equal('ok');
      if (warmResult.kind !== 'ok') return;
      expect(sortByPath(warmResult.entries)).to.deep.equal(coldEntries);
    });

    it('editing .git/info/exclude invalidates the whole warm cache', async () => {
      // Build a fresh cache, then bump info/exclude's mtime.
      const idx = await runWith(readIndex(env.gitdir));
      const cache = await runWith(buildUntrCache(env.cfg, trackedByDir(idx.entries)));
      await fs.mkdir(path.join(env.gitdir, 'info'), { recursive: true });
      await fs.writeFile(path.join(env.gitdir, 'info', 'exclude'), '*.log\n');
      await new Promise((r) => setTimeout(r, 20)); // ensure mtime advance on coarse fs
      const result = await runWith(warm(env.cfg, cache));
      expect(result.kind).to.equal('invalidated');
      if (result.kind === 'invalidated') expect(result.reason).to.equal('exclude-mtime');
    });

    it('adding a new file to a cached directory: warm invalidates that dir, picks up the new entry', async () => {
      // Build cache before mutation.
      const idx = await runWith(readIndex(env.gitdir));
      const cache = await runWith(buildUntrCache(env.cfg, trackedByDir(idx.entries)));
      // Wait so directory mtime advances reliably (cross-FS coarse mtime).
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(path.join(env.dir, 'a', 'sub', 'after-cache.txt'), 'after\n');
      const warmResult = await runWith(warm(env.cfg, cache));
      expect(warmResult.kind).to.equal('ok');
      if (warmResult.kind !== 'ok') return;
      const paths = warmResult.entries.map((e) => e.path);
      expect(paths).to.include('a/sub/after-cache.txt');
    });

    it('warm result equals fresh cold on the same state', async () => {
      // Even after a file mutation, warm + cache-rebuild equals cold.
      await fs.writeFile(path.join(env.dir, 'a', 'tracked.txt'), 'modified\n');
      // Rebuild cache fresh and run warm.
      const coldEntries = sortByPath(await collectCold(env.cfg));
      const warmResult = await collectWarm(env.cfg);
      expect(warmResult.kind).to.equal('ok');
      if (warmResult.kind !== 'ok') return;
      expect(sortByPath(warmResult.entries)).to.deep.equal(coldEntries);
    });
  });
});
