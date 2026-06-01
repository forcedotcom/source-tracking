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
import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
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
import { repoErrorToSfError, useLiteGit } from '../../../src/git/sfCompatibility';
import { Oid, RefName } from '../../../src/git/schemas';

const oid = (s: string): Oid => Schema.decodeUnknownSync(Oid)(s);
const ref = (s: string): RefName => Schema.decodeUnknownSync(RefName)(s);

/** Run useLiteGit against an injected ConfigProvider populated from a Map. */
const runWithConfig = (entries: ReadonlyArray<readonly [string, string]>): Promise<boolean> =>
  Effect.runPromise(useLiteGit.pipe(Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map(entries))))));

describe('git/integration (phase 12)', () => {
  describe('useLiteGit', () => {
    it('defaults off when the env var is absent', async () => {
      expect(await runWithConfig([])).to.equal(false);
    });

    it('on when SF_SOURCE_TRACKING_USE_LITE_GIT=true', async () => {
      expect(await runWithConfig([['SF_SOURCE_TRACKING_USE_LITE_GIT', 'true']])).to.equal(true);
    });

    it("off when SF_SOURCE_TRACKING_USE_LITE_GIT='false'", async () => {
      expect(await runWithConfig([['SF_SOURCE_TRACKING_USE_LITE_GIT', 'false']])).to.equal(false);
    });
  });

  // Keep `Config` import live for any future test that wants to reuse it.
  void Config;

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
