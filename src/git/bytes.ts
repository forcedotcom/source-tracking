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

/** Concatenate byte arrays into one contiguous, platform-independent buffer. */
export const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(total);
  // eslint-disable-next-line functional/no-let
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.byteLength;
  });
  return out;
};
