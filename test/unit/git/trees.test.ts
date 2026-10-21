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
import * as Stream from 'effect/Stream';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodePath from '@effect/platform-node/NodePath';
import { streamHeadTree } from '../../../src/git/trees.js';
import { writeLooseObject } from '../../../src/git/objects.js';
import { ObjectCorruptError } from '../../../src/git/errors.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const FixtureRoot = path.join(currentDir, '..', '..', 'git', 'fixtures');
const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer);

const readSyntheticTree = async (content: Uint8Array) => {
  const gitdir = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-tree-'));
  try {
    return await Effect.runPromiseExit(
      Effect.gen(function* () {
        const tree = yield* writeLooseObject(gitdir, 'tree', content);
        const commit = yield* writeLooseObject(gitdir, 'commit', new TextEncoder().encode(`tree ${tree}\n`));
        yield* Effect.promise(() => fs.writeFile(path.join(gitdir, 'HEAD'), `${commit}\n`));
        return yield* streamHeadTree(gitdir).pipe(Stream.runCollect);
      }).pipe(Effect.provide(TestLayer))
    );
  } finally {
    await fs.rm(gitdir, { recursive: true, force: true });
  }
};

describe('git/trees (phase 7)', () => {
  it('parses 40,000 entries without recursion or prefix copies and preserves order', async () => {
    const names = Array.from({ length: 40_000 }, (_, i) => `file-${i.toString().padStart(6, '0')}`);
    const content = Buffer.concat(
      names.map((name) => Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.alloc(20)]))
    );
    const exit = await readSyntheticTree(content);
    expect(Exit.isSuccess(exit)).to.equal(true);
    if (Exit.isSuccess(exit)) {
      expect(Array.from(exit.value, (entry) => entry.path)).to.deep.equal(names);
      expect(exit.value.every((entry) => entry.oid === '0'.repeat(40))).to.equal(true);
    }
  });

  [
    { content: Buffer.from('100644'), reason: 'no SP after mode' },
    { content: Buffer.from('invalid name\0'), reason: 'bad mode "invalid"' },
    { content: Buffer.from('100644 name'), reason: 'no NUL after name' },
    { content: Buffer.from('100644 name\0'), reason: 'truncated oid' },
  ].forEach(({ content, reason }) => {
    it(`preserves ObjectCorruptError for ${reason}`, async () => {
      const exit = await readSyntheticTree(content);
      expect(Exit.isFailure(exit)).to.equal(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).to.equal(true);
        if (Option.isSome(error)) {
          expect(error.value).to.have.property('_tag', 'ObjectCorruptError');
          if (Schema.is(ObjectCorruptError)(error.value)) expect(error.value.reason).to.equal(reason);
        }
      }
    });
  });

  it('streamHeadTree on nested-dirs/ emits expected (path, oid) pairs', async () => {
    const gitdir = path.join(FixtureRoot, 'nested-dirs', 'dot-git');
    const collected = await Effect.runPromise(
      Effect.provide(
        streamHeadTree(gitdir).pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c))
        ),
        TestLayer
      )
    );
    const paths = collected.map((c) => c.path).sort();
    expect(paths).to.deep.equal(['a/b/plain.txt', 'a/b/run.sh', 'a/link-to-plain', 'c/two.txt']);
    // every emitted oid should be 40 hex chars (validated through Oid brand)
    collected.forEach((c) => {
      expect(c.oid).to.match(/^[0-9a-f]{40}$/);
    });
  });

  it('streamHeadTree on single-file/ emits one entry', async () => {
    const gitdir = path.join(FixtureRoot, 'single-file', 'dot-git');
    const collected = await Effect.runPromise(
      Effect.provide(
        streamHeadTree(gitdir).pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c))
        ),
        TestLayer
      )
    );
    expect(collected).to.have.lengthOf(1);
    expect(collected[0]?.path).to.equal('hello.txt');
    expect(collected[0]?.oid).to.equal('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('streamHeadTree on empty/ emits no entries', async () => {
    const gitdir = path.join(FixtureRoot, 'empty', 'dot-git');
    const collected = await Effect.runPromise(
      Effect.provide(
        streamHeadTree(gitdir).pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c))
        ),
        TestLayer
      )
    );
    expect(collected).to.have.lengthOf(0);
  });
});
