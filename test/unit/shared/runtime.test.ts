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
import * as Effect from 'effect/Effect';
import { runPromise } from '../../../src/shared/runtime';

describe('runPromise', () => {
  it('rejects with the original error from a typed failure', async () => {
    const original = new SfError('typed', 'TypedFailure');
    try {
      await runPromise(Effect.fail(original));
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).to.be.instanceOf(SfError);
      expect(e).to.equal(original);
    }
  });

  it('rejects with the original error from a defect (Effect.sync that throws)', async () => {
    const original = new SfError('defect', 'Defect');
    try {
      await runPromise(
        Effect.sync(() => {
          throw original;
        })
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).to.be.instanceOf(SfError);
      expect(e).to.equal(original);
    }
  });

  it('rejects with the original error from a tryPromise rejection', async () => {
    const original = new SfError('rejected', 'Rejected');
    try {
      await runPromise(
        Effect.tryPromise({
          try: () => Promise.reject(original),
          catch: (e) => e,
        })
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).to.be.instanceOf(SfError);
      expect(e).to.equal(original);
    }
  });

  it('rejects with the original error after Effect.catchAll(Effect.sync(throw))', async () => {
    const original = new SfError('redirected', 'Redirected');
    try {
      await runPromise(
        Effect.tryPromise({
          try: () => Promise.reject(new Error('inner')),
          catch: (e) => e,
        }).pipe(
          Effect.catchAll(() =>
            Effect.sync(() => {
              throw original;
            })
          )
        )
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).to.be.instanceOf(SfError);
      expect(e).to.equal(original);
    }
  });
});
