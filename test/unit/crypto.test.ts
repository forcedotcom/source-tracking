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
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect } from 'chai';
import { build } from 'esbuild';
import { Crypto } from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import { cryptoLayer } from '../../src/shared/local/crypto.js';

const expectedDigest = 'a9993e364706816aba3e25717850c26c9cd0d89d';
const digest = Effect.gen(function* () {
  const crypto = yield* Crypto;
  return yield* crypto.digest('SHA-1', new TextEncoder().encode('abc'));
});

describe('local tracking platform crypto', () => {
  it('defaults to Node crypto without caller configuration', async () => {
    const bytes = await Effect.runPromise(digest.pipe(Effect.provide(cryptoLayer)));
    expect(Buffer.from(bytes).toString('hex')).to.equal(expectedDigest);
  });

  for (const platform of ['node', 'web'] as const) {
    it(`bundles and hashes for ${platform} without the other platform's crypto implementation`, async () => {
      const bundle = await build({
        stdin: {
          contents: `
            import { Crypto } from 'effect/Crypto';
            import * as Effect from 'effect/Effect';
            import { cryptoLayer } from './src/shared/local/crypto.js';
            export const run = () => Effect.runPromise(Effect.gen(function* () {
              const crypto = yield* Crypto;
              const bytes = yield* crypto.digest('SHA-1', new TextEncoder().encode('abc'));
              const random = yield* crypto.randomBytes(16);
              return {
                digest: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
                randomBytesLength: random.length,
              };
            }).pipe(Effect.provide(cryptoLayer)));
          `,
          resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
        },
        bundle: true,
        platform: platform === 'web' ? 'browser' : 'node',
        format: 'iife',
        globalName: 'cryptoTest',
        define: { 'process.env.ESBUILD_PLATFORM': JSON.stringify(platform) },
        supported: { 'dynamic-import': false },
        metafile: true,
        write: false,
      });
      const emittedInputs = Object.values(bundle.metafile.outputs).flatMap((output) => Object.keys(output.inputs));
      const excludedCrypto = platform === 'web' ? '/NodeCrypto.' : '/BrowserCrypto.';
      expect(emittedInputs.some((input) => input.includes(excludedCrypto))).to.equal(false);

      // The web sandbox deliberately has no process, require, Buffer, or Node polyfills.
      const result = (await runInNewContext(`${bundle.outputFiles[0].text}\ncryptoTest.run()`, {
        TextEncoder,
        setTimeout,
        clearTimeout,
        ...(platform === 'web' ? { crypto: webcrypto } : { require: createRequire(import.meta.url) }),
      })) as { digest: string; randomBytesLength: number };
      expect(result.digest).to.equal(expectedDigest);
      expect(result.randomBytesLength).to.equal(16);
    });
  }
});
