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
import * as HashMap from 'effect/HashMap';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import {
  type UntrCache,
  UntrCache as UntrCacheSchema,
  UntrCacheJson,
  type UntrEntry,
  readUntrCache,
  writeUntrCache,
} from '../../../src/git/untrCache';

const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const run = <A, E>(eff: Effect.Effect<A, E, FileSystem | Path>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, TestLayer));

const sampleEntry = (): UntrEntry => ({
  fingerprint: { mtimeMs: 1_700_000_000_000, size: 4096, gitignoreMtimeMs: 0 },
  untracked: [
    { name: 'a.txt', status: 'added' },
    { name: 'b.log', status: 'ignored' },
  ],
  trackedNames: ['tracked.txt'],
});

const sampleCache = (): UntrCache => ({
  schemaVersion: 1,
  excludeMtimeMs: 1_700_000_000_000,
  entries: HashMap.fromIterable([
    ['', sampleEntry()],
    ['force-app/main/default', sampleEntry()],
  ]),
});

describe('git/untrCache codec', () => {
  it('round-trips a sample cache through Schema.parseJson', () => {
    const original = sampleCache();
    const wire = Schema.encodeSync(UntrCacheJson)(original);
    const decoded = Schema.decodeSync(UntrCacheJson)(wire);
    expect(decoded.schemaVersion).to.equal(1);
    expect(decoded.excludeMtimeMs).to.equal(original.excludeMtimeMs);
    expect(HashMap.size(decoded.entries)).to.equal(HashMap.size(original.entries));
  });

  it('round-trips with both added and ignored statuses', () => {
    const cache = sampleCache();
    const wire = Schema.encodeSync(UntrCacheJson)(cache);
    const back = Schema.decodeSync(UntrCacheJson)(wire);
    const entry = Option.getOrThrow(HashMap.get(back.entries, ''));
    expect(entry.untracked.map((u) => u.status)).to.deep.equal(['added', 'ignored']);
  });

  it('round-trips an empty cache', () => {
    const empty: UntrCache = { schemaVersion: 1, excludeMtimeMs: 0, entries: HashMap.empty() };
    const wire = Schema.encodeSync(UntrCacheJson)(empty);
    const back = Schema.decodeSync(UntrCacheJson)(wire);
    expect(HashMap.size(back.entries)).to.equal(0);
  });

  it('rejects schemaVersion: 2 (forward-incompatible bump)', () => {
    const bad = JSON.stringify({ schemaVersion: 2, excludeMtimeMs: 0, entries: [] });
    expect(() => Schema.decodeSync(UntrCacheJson)(bad)).to.throw();
    expect(() =>
      Schema.decodeUnknownSync(UntrCacheSchema)({ schemaVersion: 2, excludeMtimeMs: 0, entries: [] })
    ).to.throw();
  });

  describe('disk I/O', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'untr-cache-'));
    });
    afterEach(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('readUntrCache returns None for a missing file', async () => {
      const result = await run(readUntrCache(tmp));
      expect(Option.isNone(result)).to.equal(true);
    });

    it('readUntrCache returns None for malformed JSON', async () => {
      await fs.mkdir(path.join(tmp, 'sftracking'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'sftracking', 'untr.json'), '{ not valid json');
      const result = await run(readUntrCache(tmp));
      expect(Option.isNone(result)).to.equal(true);
    });

    it('readUntrCache returns None for a forward-incompatible schemaVersion', async () => {
      await fs.mkdir(path.join(tmp, 'sftracking'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'sftracking', 'untr.json'),
        JSON.stringify({ schemaVersion: 2, excludeMtimeMs: 0, entries: [] })
      );
      const result = await run(readUntrCache(tmp));
      expect(Option.isNone(result)).to.equal(true);
    });

    it('writeUntrCache + readUntrCache round-trip preserves HashMap contents', async () => {
      const cache = sampleCache();
      await run(writeUntrCache(tmp, cache));
      const loaded = await run(readUntrCache(tmp));
      expect(Option.isSome(loaded)).to.equal(true);
      const got = Option.getOrThrow(loaded).cache;
      expect(got.schemaVersion).to.equal(1);
      expect(got.excludeMtimeMs).to.equal(cache.excludeMtimeMs);
      expect(HashMap.size(got.entries)).to.equal(2);
      const root = Option.getOrThrow(HashMap.get(got.entries, ''));
      expect(root.untracked).to.have.lengthOf(2);
      expect(root.trackedNames).to.deep.equal(['tracked.txt']);
      expect(root.fingerprint.size).to.equal(4096);
    });

    it('writeUntrCache exposes mtimeMs alongside the cache on read', async () => {
      const cache = sampleCache();
      await run(writeUntrCache(tmp, cache));
      const loaded = await run(readUntrCache(tmp));
      expect(Option.getOrThrow(loaded).mtimeMs).to.be.greaterThan(0);
    });
  });
});
