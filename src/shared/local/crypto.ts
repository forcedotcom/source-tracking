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
import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto';
import type * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

// Inline build-time comparison lets web bundles drop the Node import entirely.
// Unbundled consumers default to Node without configuring a layer.
export const cryptoLayer: Layer.Layer<Crypto.Crypto> =
  process.env.ESBUILD_PLATFORM === 'web'
    ? BrowserCrypto.layer
    : Layer.unwrap(Effect.promise(async () => (await import('@effect/platform-node/NodeCrypto')).layer));
