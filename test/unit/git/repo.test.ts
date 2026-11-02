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
import path from 'node:path';
import os from 'node:os';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as Schema from 'effect/Schema';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as Crypto from 'effect/Crypto';
import { FileSystem } from 'effect/FileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Repo } from '../../../src/git/repo.js';
import { RefName, RepoPath, type RepoConfig } from '../../../src/git/schemas.js';

const cfg = (gitdir: string): RepoConfig => ({
  dir: path.dirname(gitdir),
  gitdir,
  roots: [Schema.decodeUnknownSync(RepoPath)('force-app')],
  fdPermits: 8,
});

describe('git/Repo configuration', () => {
  for (const fdPermits of [1, 4, 64]) {
    it(`limits tracked-file status reads to ${fdPermits} configured I/O permits`, async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'git-repo-status-concurrency-'));
      try {
        const packageDir = path.join(tmp, 'force-app');
        await fs.mkdir(packageDir);
        const files = Array.from({ length: fdPermits + 1 }, (_, index) =>
          Schema.decodeUnknownSync(RepoPath)(`force-app/file-${index}.txt`)
        );
        await Promise.all(files.map((file) => fs.writeFile(path.join(tmp, file), 'tracked content\n')));

        let activeReads = 0;
        let maxActiveReads = 0;
        const measuredFileSystem = Layer.effect(
          FileSystem,
          Effect.map(FileSystem, (fileSystem) => ({
            ...fileSystem,
            readFile: (file: string) =>
              file.startsWith(`${packageDir}${path.sep}`)
                ? Effect.acquireUseRelease(
                    Effect.sync(() => {
                      activeReads++;
                      maxActiveReads = Math.max(maxActiveReads, activeReads);
                    }),
                    () => fileSystem.readFile(file),
                    () => Effect.sync(() => activeReads--)
                  )
                : fileSystem.readFile(file),
          }))
        ).pipe(Layer.provide(NodeFileSystem.layer));

        await Effect.gen(function* () {
          const repo = yield* Repo;
          yield* repo.init();
          yield* repo.applyChanges({
            adds: Stream.fromIterable(files),
            removes: Stream.empty,
            message: 'track files',
            author: { name: 'Test', email: 'test@example.com' },
          });
          maxActiveReads = 0;
          const entries = yield* repo.statusMatrix().pipe(Stream.runCollect);
          expect(entries).to.have.length(files.length);
          expect(entries.every((entry) => entry.status === 'unmodified')).to.equal(true);
          expect(activeReads).to.equal(0);
          expect(maxActiveReads).to.be.greaterThan(0).and.at.most(fdPermits);
        }).pipe(
          Effect.provide(
            Repo.layer({ ...cfg(path.join(tmp, '.git')), fdPermits }).pipe(
              Layer.provide(Layer.mergeAll(measuredFileSystem, NodePath.layer, NodeCrypto.layer))
            )
          ),
          Effect.runPromise
        );
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  }

  it('initializes and reads the repository configured by its layer', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'git-repo-config-'));
    try {
      await Effect.gen(function* () {
        const repo = yield* Repo;
        const oid = yield* repo.init();
        expect(yield* repo.resolveRef(Schema.decodeUnknownSync(RefName)('HEAD'))).to.equal(oid);
        expect(yield* repo.statusMatrix().pipe(Stream.runCollect)).to.deep.equal([]);
      }).pipe(
        Effect.provide(
          Repo.layer(cfg(path.join(tmp, '.git'))).pipe(
            Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
          )
        ),
        Effect.runPromise
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps the captured Crypto alive until the repository layer is disposed', async () => {
    const calls: string[] = [];
    const lifecycle: string[] = [];
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (algorithm, bytes) => {
        calls.push(`${algorithm}:${new TextDecoder().decode(bytes)}`);
        return Effect.succeed(new Uint8Array(20).fill(0xab));
      },
    });
    const cryptoLayer = Layer.effect(
      Crypto.Crypto,
      Effect.acquireRelease(
        Effect.sync(() => {
          lifecycle.push('acquire');
          return crypto;
        }),
        () => Effect.sync(() => lifecycle.push('release'))
      )
    );
    const layer = Repo.layer(cfg('unused/.git')).pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, cryptoLayer))
    );
    const hash = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repo;
        expect(lifecycle).to.deep.equal(['acquire']);
        // No ambient Crypto service: only Repo is provided to this program.
        return yield* repo.hashBlob(new TextEncoder().encode('hello'));
      }).pipe(Effect.provide(layer))
    );
    expect(hash).to.equal('ab'.repeat(20));
    expect(calls).to.deep.equal(['SHA-1:blob 5\0hello']);
    expect(lifecycle).to.deep.equal(['acquire', 'release']);
  });
});
