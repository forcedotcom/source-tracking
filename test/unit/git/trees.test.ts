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
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { streamHeadTree } from '../../../src/git/trees';

const FixtureRoot = path.join(__dirname, '..', '..', 'git', 'fixtures');
const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

describe('git/trees (phase 7)', () => {
  it('streamHeadTree on nested-dirs/ emits expected (path, oid) pairs', async () => {
    const gitdir = path.join(FixtureRoot, 'nested-dirs', 'dot-git');
    const collected = await Effect.runPromise(
      Effect.provide(
        streamHeadTree(gitdir).pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c))
        ) as unknown as Effect.Effect<
          ReadonlyArray<{ readonly path: string; readonly oid: string }>,
          unknown,
          FileSystem | Path
        >,
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
        ) as unknown as Effect.Effect<
          ReadonlyArray<{ readonly path: string; readonly oid: string }>,
          unknown,
          FileSystem | Path
        >,
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
        ) as unknown as Effect.Effect<
          ReadonlyArray<{ readonly path: string; readonly oid: string }>,
          unknown,
          FileSystem | Path
        >,
        TestLayer
      )
    );
    expect(collected).to.have.lengthOf(0);
  });
});
