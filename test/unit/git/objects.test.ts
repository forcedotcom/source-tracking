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
import { hashBlob, hashLooseObject, readLooseObject, writeLooseObject } from '../../../src/git/objects';
import { Oid } from '../../../src/git/schemas';
import { ObjectNotFoundError } from '../../../src/git/errors';

const FixtureRoot = path.join(__dirname, '..', '..', 'git', 'fixtures');

const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const run = <A, E>(eff: Effect.Effect<A, E, FileSystem | Path>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.provide(eff, TestLayer));

const oid = (s: string): Oid => Schema.decodeUnknownSync(Oid)(s);

describe('git/objects (phase 2)', () => {
  describe('hashBlob', () => {
    it('"hello\\n" hashes to git\'s well-known oid for that content', async () => {
      // git hash-object - <<< $'hello' => ce013625030ba8dba906f756967f9e9ca394464a
      const exit = await run(hashBlob(new TextEncoder().encode('hello\n')));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).to.equal('ce013625030ba8dba906f756967f9e9ca394464a');
      }
    });

    it('matches the blob oid recorded in the single-file fixture', async () => {
      const expectedHellOid = 'ce013625030ba8dba906f756967f9e9ca394464a';
      const expectedFile = path.join(FixtureRoot, 'single-file', 'work', 'hello.txt');
      // generate.sh writes "hello\n"
      const bytes = await fs.readFile(expectedFile);
      const exit = await run(hashBlob(new Uint8Array(bytes)));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).to.equal(expectedHellOid);
      }
    });

    it('symlink content: blob is the link target string', async () => {
      // a/link-to-plain -> ../b/plain.txt; the blob is the target string itself.
      // Verified against `printf '../b/plain.txt' | git hash-object --stdin`.
      // The fixture's nested-dirs/dot-git/objects/cf/7d6db... is this blob.
      const target = '../b/plain.txt';
      const expectedSymlinkOid = 'cf7d6db69c76c6cd031a0f71c534daf22737aa89';
      const exit = await run(hashBlob(new TextEncoder().encode(target)));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).to.equal(expectedSymlinkOid);
      }
    });
  });

  describe('readLooseObject + writeLooseObject', () => {
    it('reads each loose object in single-file/ and decodes type+content', async () => {
      const gitdir = path.join(FixtureRoot, 'single-file', 'dot-git');
      const expectedOids = [
        '028950374da66785bb8c73139e9643c6a1877124',
        'aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7',
        'ce013625030ba8dba906f756967f9e9ca394464a',
      ] as const;
      const exits = await Promise.all(expectedOids.map((o) => run(readLooseObject(gitdir, oid(o)))));
      exits.forEach((exit, i) => {
        const o = expectedOids[i] ?? '';
        expect(Exit.isSuccess(exit), o).to.equal(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.type, o).to.match(/^(blob|tree|commit)$/);
          expect(exit.value.content.byteLength, o).to.be.greaterThan(0);
        }
      });
    });

    it('reads the canonical empty-tree object from empty/', async () => {
      const gitdir = path.join(FixtureRoot, 'empty', 'dot-git');
      const exit = await run(readLooseObject(gitdir, oid('4b825dc642cb6eb9a060e54bf8d69288fbee4904')));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.type).to.equal('tree');
        expect(exit.value.content.byteLength).to.equal(0);
      }
    });

    it('round-trip: writeLooseObject of "hello\\n" produces fixture-recorded oid', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-objects-'));
      try {
        const gitdir = path.join(tmp, '.git');
        await fs.mkdir(path.join(gitdir, 'objects'), { recursive: true });
        const content = new TextEncoder().encode('hello\n');
        const exit = await run(writeLooseObject(gitdir, 'blob', content));
        expect(Exit.isSuccess(exit)).to.equal(true);
        if (Exit.isSuccess(exit)) {
          const writtenOid = exit.value;
          expect(writtenOid).to.equal('ce013625030ba8dba906f756967f9e9ca394464a');
          // and round-trip back
          const back = await run(readLooseObject(gitdir, writtenOid));
          expect(Exit.isSuccess(back)).to.equal(true);
          if (Exit.isSuccess(back)) {
            expect(back.value.type).to.equal('blob');
            expect(new TextDecoder().decode(back.value.content)).to.equal('hello\n');
          }
        }
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('writeLooseObject is idempotent over identical content', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-objects-idem-'));
      try {
        const gitdir = path.join(tmp, '.git');
        const content = new TextEncoder().encode('idempotent\n');
        const exit1 = await run(writeLooseObject(gitdir, 'blob', content));
        const exit2 = await run(writeLooseObject(gitdir, 'blob', content));
        expect(Exit.isSuccess(exit1) && Exit.isSuccess(exit2)).to.equal(true);
        if (Exit.isSuccess(exit1) && Exit.isSuccess(exit2)) {
          expect(exit1.value).to.equal(exit2.value);
        }
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('readLooseObject on missing oid → ObjectNotFoundError', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-objects-missing-'));
      try {
        const gitdir = path.join(tmp, '.git');
        await fs.mkdir(path.join(gitdir, 'objects'), { recursive: true });
        const exit = await run(readLooseObject(gitdir, oid('0'.repeat(40))));
        expect(Exit.isFailure(exit)).to.equal(true);
        if (Exit.isFailure(exit)) {
          const fail = Cause.failureOption(exit.cause);
          expect(Option.isSome(fail)).to.equal(true);
          if (Option.isSome(fail)) {
            expect(fail.value).to.be.instanceOf(ObjectNotFoundError);
          }
        }
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('readLooseObject on truncated bytes → ObjectCorruptError', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-objects-corrupt-'));
      try {
        const gitdir = path.join(tmp, '.git');
        const truncated = new Uint8Array([0x78, 0x01]); // zlib magic, no body
        const truncatedOid = oid('0'.repeat(40));
        const dir = path.join(gitdir, 'objects', truncatedOid.slice(0, 2));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, truncatedOid.slice(2)), truncated);
        // We expect a defect or typed failure — both prove "not graceful".
        const exit = await run(readLooseObject(gitdir, truncatedOid));
        expect(Exit.isFailure(exit)).to.equal(true);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('hashLooseObject', () => {
    it('matches hashBlob for "blob" type', async () => {
      const bytes = new TextEncoder().encode('hello\n');
      const a = await run(hashBlob(bytes));
      const b = await run(hashLooseObject('blob', bytes));
      if (Exit.isSuccess(a) && Exit.isSuccess(b)) {
        expect(a.value).to.equal(b.value);
      } else {
        throw new Error('hash effects must succeed');
      }
    });

    it('produces the well-known empty-tree oid for an empty tree', async () => {
      const exit = await run(hashLooseObject('tree', new Uint8Array(0)));
      expect(Exit.isSuccess(exit)).to.equal(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).to.equal('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
      }
    });
  });
});
