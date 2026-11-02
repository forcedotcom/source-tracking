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

import * as Effect from 'effect/Effect';
import {
  DEFAULT_SOURCE_TRACKING_SETTINGS,
  sourceTrackingConfigLayer,
  type SourceTrackingSettings,
} from '../../src/config.js';
import { createShadowRepo as createShadowRepoEffect, type ShadowRepo } from '../../src/shared/local/localShadowRepo.js';
import type { ShadowRepoOptions } from '../../src/shared/local/types.js';

export type { ShadowRepo };

/** Run the Effect factory with an injected config layer for local-tracking tests. */
export const createShadowRepo = (
  options: ShadowRepoOptions,
  settings: SourceTrackingSettings = DEFAULT_SOURCE_TRACKING_SETTINGS
): Promise<ShadowRepo> =>
  Effect.runPromise(Effect.provide(createShadowRepoEffect(options), sourceTrackingConfigLayer(settings)));
