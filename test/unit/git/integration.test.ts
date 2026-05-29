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
import { SfError } from '@salesforce/core';
import * as Schema from 'effect/Schema';
import {
  IndexCorruptError,
  ObjectCorruptError,
  ObjectNotFoundError,
  RefNotFoundError,
  RepoLockedError,
  RepoNotConfiguredError,
  WorkdirIoError,
} from '../../../src/git/errors';
import { repoErrorToSfError, useLiteGit } from '../../../src/git/integration';
import { Oid, RefName } from '../../../src/git/schemas';

const oid = (s: string): Oid => Schema.decodeUnknownSync(Oid)(s);
const ref = (s: string): RefName => Schema.decodeUnknownSync(RefName)(s);

describe('git/integration (phase 12)', () => {
  describe('useLiteGit', () => {
    it('defaults off', () => {
      delete process.env.SF_SOURCE_TRACKING_USE_LITE_GIT;
      expect(useLiteGit()).to.equal(false);
    });

    it('on when SF_SOURCE_TRACKING_USE_LITE_GIT=true', () => {
      process.env.SF_SOURCE_TRACKING_USE_LITE_GIT = 'true';
      try {
        expect(useLiteGit()).to.equal(true);
      } finally {
        delete process.env.SF_SOURCE_TRACKING_USE_LITE_GIT;
      }
    });

    it('off for any other truthy value (strict "true" only)', () => {
      process.env.SF_SOURCE_TRACKING_USE_LITE_GIT = '1';
      try {
        expect(useLiteGit()).to.equal(false);
      } finally {
        delete process.env.SF_SOURCE_TRACKING_USE_LITE_GIT;
      }
    });
  });

  describe('repoErrorToSfError', () => {
    it('maps every tag to an SfError with a stable name', () => {
      const cases = [
        new RepoLockedError({ lockPath: '/x/y/.git/index.lock', ageMs: 1000, ageHumanReadable: '1s', message: 'm' }),
        new IndexCorruptError({ gitdir: '/x/.git', reason: 'partial-shadow', message: 'm' }),
        new ObjectNotFoundError({ oid: oid('a'.repeat(40)), message: 'm' }),
        new ObjectCorruptError({ oid: oid('b'.repeat(40)), reason: 'sha mismatch', message: 'm' }),
        new RepoNotConfiguredError({ message: 'never switched' }),
        new RefNotFoundError({ ref: ref('refs/heads/missing'), message: 'm' }),
      ] as const;
      cases.forEach((c) => {
        const sf = repoErrorToSfError(c);
        expect(sf).to.be.instanceOf(SfError);
        expect(sf.name).to.be.a('string');
        expect(sf.message).to.be.a('string');
      });
    });

    it('maps WorkdirIoError', () => {
      const e = new WorkdirIoError({ path: '/x/y', cause: { _tag: 'SystemError' } as never, message: 'fs broke' });
      const sf = repoErrorToSfError(e);
      expect(sf.name).to.equal('workdirIo');
    });
  });
});
