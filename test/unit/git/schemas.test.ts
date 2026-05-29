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
import { expect } from 'chai';
import * as Either from 'effect/Either';
import * as Schema from 'effect/Schema';
import * as ParseResult from 'effect/ParseResult';
import { Author, Oid, RefName, RepoPath, StatusEntry, SwitchCfg } from '../../../src/git/schemas';

const decode = <A, I>(s: Schema.Schema<A, I>): ((u: unknown) => Either.Either<A, ParseResult.ParseError>) =>
  Schema.decodeUnknownEither(s);

describe('git/schemas', () => {
  describe('Oid', () => {
    it('accepts a 40-char lowercase hex string', () => {
      const result = decode(Oid)('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(Either.isRight(result)).to.equal(true);
    });

    it('rejects shorter strings', () => {
      const result = decode(Oid)('aaa');
      expect(Either.isLeft(result)).to.equal(true);
    });

    it('rejects uppercase hex (canonical git is lowercase)', () => {
      const result = decode(Oid)('A'.repeat(40));
      expect(Either.isLeft(result)).to.equal(true);
    });

    it('rejects non-hex characters', () => {
      const result = decode(Oid)('z'.repeat(40));
      expect(Either.isLeft(result)).to.equal(true);
    });
  });

  describe('RepoPath', () => {
    it('accepts a posix workdir-relative path', () => {
      const result = decode(RepoPath)('force-app/main/default/classes/Foo.cls');
      expect(Either.isRight(result)).to.equal(true);
    });

    it('rejects empty', () => {
      expect(Either.isLeft(decode(RepoPath)(''))).to.equal(true);
    });

    it('rejects absolute paths', () => {
      expect(Either.isLeft(decode(RepoPath)('/abs'))).to.equal(true);
    });

    it('rejects backslashes', () => {
      expect(Either.isLeft(decode(RepoPath)('a\\b'))).to.equal(true);
    });

    it('rejects ".." segments', () => {
      expect(Either.isLeft(decode(RepoPath)('a/../b'))).to.equal(true);
    });

    it('rejects "." segments', () => {
      expect(Either.isLeft(decode(RepoPath)('a/./b'))).to.equal(true);
    });

    it('rejects empty segments (double slash)', () => {
      expect(Either.isLeft(decode(RepoPath)('a//b'))).to.equal(true);
    });

    it('rejects NUL bytes', () => {
      expect(Either.isLeft(decode(RepoPath)('a\0b'))).to.equal(true);
    });
  });

  describe('RefName', () => {
    it('accepts HEAD', () => {
      expect(Either.isRight(decode(RefName)('HEAD'))).to.equal(true);
    });

    it('accepts refs/heads/main', () => {
      expect(Either.isRight(decode(RefName)('refs/heads/main'))).to.equal(true);
    });

    it('rejects bare branch names', () => {
      expect(Either.isLeft(decode(RefName)('main'))).to.equal(true);
    });
  });

  describe('StatusEntry', () => {
    it('accepts the five public statuses', () => {
      const path = Schema.decodeUnknownSync(RepoPath)('a/b.txt');
      for (const status of ['unmodified', 'modified', 'added', 'deleted', 'ignored'] as const) {
        const result = decode(StatusEntry)({ path, status });
        expect(Either.isRight(result), status).to.equal(true);
      }
    });

    it('rejects an unknown status (e.g. "renamed")', () => {
      const path = Schema.decodeUnknownSync(RepoPath)('a/b.txt');
      expect(Either.isLeft(decode(StatusEntry)({ path, status: 'renamed' }))).to.equal(true);
    });
  });

  describe('Author', () => {
    it('accepts a non-empty name+email', () => {
      const result = decode(Author)({ name: 'sfdx', email: 'noreply@salesforce.com' });
      expect(Either.isRight(result)).to.equal(true);
    });

    it('rejects empty name', () => {
      expect(Either.isLeft(decode(Author)({ name: '', email: 'a@b.c' }))).to.equal(true);
    });
  });

  describe('SwitchCfg', () => {
    it('accepts a typical CLI invocation', () => {
      const result = decode(SwitchCfg)({
        dir: '/abs/project',
        gitdir: '/abs/project/.sf/orgs/x/localSourceTracking/.git',
        roots: [Schema.decodeUnknownSync(RepoPath)('force-app')],
        fdPermits: 16,
      });
      expect(Either.isRight(result)).to.equal(true);
    });

    it('rejects fdPermits = 0', () => {
      expect(
        Either.isLeft(
          decode(SwitchCfg)({
            dir: '/abs/project',
            gitdir: '/abs/project/.git',
            roots: [],
            fdPermits: 0,
          })
        )
      ).to.equal(true);
    });
  });
});
