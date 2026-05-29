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
import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';

/**
 * Capabilities the active FileSystem layer reports about its backing fs.
 *
 * Lite does no platform detection — no `process.platform`, no `typeof window`.
 * Layer authors set the flag based on what they know their fs supports.
 * Node FileSystem layer should set `supportsUntr: true` (real fs);
 * memfs FileSystem layer should set `supportsUntr: false` (no stable
 * ino/mtime_nsec semantics across writers).
 */
export type Capabilities = {
  readonly supportsUntr: boolean;
};

export class CapabilitiesTag extends Context.Tag('@source-tracking/Capabilities')<CapabilitiesTag, Capabilities>() {}

// Default-on layer for Node consumers. The plan keeps the actual
// platform-specific UNTR probe in phase 11; this Layer only declares the
// capability flag.
export const NodeCapabilitiesLayer: Layer.Layer<CapabilitiesTag> = Layer.succeed(CapabilitiesTag, {
  supportsUntr: true,
});

// Default-off layer for memfs / browser consumers.
export const MemfsCapabilitiesLayer: Layer.Layer<CapabilitiesTag> = Layer.succeed(CapabilitiesTag, {
  supportsUntr: false,
});
