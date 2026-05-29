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
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { IndexCorruptError } from './errors';
import { Oid } from './schemas';

/**
 * Git index v2 layout (from `Documentation/technical/index-format.txt`).
 *
 * Header is "DIRC" (4) + version u32 (4) + entry-count u32 (4) = 12 bytes.
 * Each entry has 10 u32 stat fields (ctime_sec, ctime_nsec, mtime_sec,
 * mtime_nsec, dev, ino, mode, uid, gid, size), a 20-byte oid, a u16 flags
 * field (bits: assume_valid, extended which must be 0 in v2, stage 2 bits,
 * name-length 12 bits), then the NUL-terminated UTF-8 pathname, then pad
 * to 8-byte alignment from the start of the entry.
 *
 * Extensions are (4-byte signature, u32 size, payload). The trailer is
 * 20 bytes SHA-1 of all preceding bytes.
 */

const HEADER_BYTES = 12;
const ENTRY_FIXED_BYTES = 62; // 10×u32 + 20 oid + 2 flags
const TRAILER_BYTES = 20;
const SIGNATURE_DIRC = 0x44_49_52_43;
const VERSION_V2 = 2;

export type IndexEntry = {
  readonly path: string;
  readonly oid: Oid;
  readonly mode: number;
  readonly stage: 0 | 1 | 2 | 3;
  readonly assumeValid: boolean;
  readonly stat: {
    readonly ctimeSec: number;
    readonly ctimeNsec: number;
    readonly mtimeSec: number;
    readonly mtimeNsec: number;
    readonly dev: number;
    readonly ino: number;
    readonly uid: number;
    readonly gid: number;
    readonly size: number;
  };
};

export type IndexV2 = {
  readonly entries: readonly IndexEntry[];
  /** Bytes used by entries (excluding header). Phase 9's writer needs this. */
  readonly entriesByteLength: number;
  /** Raw extension blocks captured for round-trip; phase 11 parses UNTR. */
  readonly extensions: ReadonlyArray<{ readonly signature: string; readonly payload: Uint8Array }>;
  readonly trailer: Uint8Array;
};

const HEX_CHARS = '0123456789abcdef';
const hexNibble = (n: number): string => HEX_CHARS[n] ?? '';

const oidFromBytes = (bytes: Uint8Array): Oid =>
  Schema.decodeUnknownSync(Oid)(
    Array.from(bytes.subarray(0, 20), (b) => `${hexNibble(b >>> 4)}${hexNibble(b & 0x0f)}`).join('')
  );

const ASCII = new TextDecoder('utf-8', { fatal: false });

const corrupt = (reason: string, gitdir: string): IndexCorruptError =>
  new IndexCorruptError({ gitdir, reason, message: `index v2 parse: ${reason}` });

type ParsedEntry = { readonly entry: IndexEntry; readonly nextOffset: number };

const findNul = (raw: Uint8Array, from: number, end: number): number => {
  const ix = raw.subarray(from, end).indexOf(0);
  return ix < 0 ? -1 : from + ix;
};

const parseEntryAt = (raw: Uint8Array, view: DataView, offset: number, gitdir: string, i: number): ParsedEntry => {
  const start = offset;
  const trailerStart = raw.byteLength - TRAILER_BYTES;
  if (offset + ENTRY_FIXED_BYTES > trailerStart) {
    throw corrupt(`entry ${i} fixed-fields overflow at offset ${offset}`, gitdir);
  }
  const flags = view.getUint16(offset + 60, false);
  const extended = (flags & 0x40_00) !== 0;
  if (extended) throw corrupt(`entry ${i} sets extended flag (v3 only)`, gitdir);
  const nameLen = flags & 0x0f_ff;
  const pathStart = offset + ENTRY_FIXED_BYTES;
  const pathEnd = nameLen === 0x0f_ff ? findNul(raw, pathStart, trailerStart) : pathStart + nameLen;
  if (pathEnd < 0 || pathEnd > trailerStart) throw corrupt(`entry ${i} path overflow`, gitdir);
  const total = pathEnd - start;
  const pad = 8 - (total % 8);
  return {
    entry: {
      path: ASCII.decode(raw.subarray(pathStart, pathEnd)),
      oid: oidFromBytes(raw.subarray(offset + 40, offset + 60)),
      mode: view.getUint32(offset + 24, false),
      stage: ((flags >> 12) & 0x3) as 0 | 1 | 2 | 3,
      assumeValid: (flags & 0x80_00) !== 0,
      stat: {
        ctimeSec: view.getUint32(offset, false),
        ctimeNsec: view.getUint32(offset + 4, false),
        mtimeSec: view.getUint32(offset + 8, false),
        mtimeNsec: view.getUint32(offset + 12, false),
        dev: view.getUint32(offset + 16, false),
        ino: view.getUint32(offset + 20, false),
        uid: view.getUint32(offset + 28, false),
        gid: view.getUint32(offset + 32, false),
        size: view.getUint32(offset + 36, false),
      },
    },
    nextOffset: pathEnd + pad,
  };
};

type ParsedExtension = { readonly signature: string; readonly payload: Uint8Array };

const parseExtensionsFrom = (
  raw: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  gitdir: string,
  acc: readonly ParsedExtension[] = []
): readonly ParsedExtension[] => {
  if (start === end) return acc;
  if (start + 8 > end) throw corrupt('truncated extension header', gitdir);
  const signature = ASCII.decode(raw.subarray(start, start + 4));
  const size = view.getUint32(start + 4, false);
  const payloadStart = start + 8;
  if (payloadStart + size > end) throw corrupt(`extension ${signature} payload overflow`, gitdir);
  const payload = raw.subarray(payloadStart, payloadStart + size);
  return parseExtensionsFrom(raw, view, payloadStart + size, end, gitdir, [...acc, { signature, payload }]);
};

/**
 * Parse `.git/index` (version 2 only). Rejects v3/v4 with IndexCorruptError.
 * The trailing SHA is captured but not verified here — verification is the
 * writer's mirror; verifying on read costs 1 sha1 per parse and the index
 * is parsed in the hot status path.
 */
export const parseIndexV2 = (gitdir: string, raw: Uint8Array): Effect.Effect<IndexV2, IndexCorruptError> =>
  Effect.sync(() => {
    if (raw.byteLength < HEADER_BYTES + TRAILER_BYTES) {
      throw corrupt(`buffer too short (${raw.byteLength} bytes)`, gitdir);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const sig = view.getUint32(0, false);
    if (sig !== SIGNATURE_DIRC) throw corrupt(`bad magic ${sig.toString(16)}`, gitdir);
    const version = view.getUint32(4, false);
    if (version !== VERSION_V2) throw corrupt(`unsupported version ${version}; only v2 is supported`, gitdir);
    const entryCount = view.getUint32(8, false);

    // Fold over `entryCount` indices, threading the byte offset.
    const { entries, offset } = Array.from({ length: entryCount }, (_, i) => i).reduce<{
      readonly entries: readonly IndexEntry[];
      readonly offset: number;
    }>(
      (acc, i) => {
        const { entry, nextOffset } = parseEntryAt(raw, view, acc.offset, gitdir, i);
        return { entries: [...acc.entries, entry], offset: nextOffset };
      },
      { entries: [], offset: HEADER_BYTES }
    );

    const entriesByteLength = offset - HEADER_BYTES;
    const extEnd = raw.byteLength - TRAILER_BYTES;
    const extensions = parseExtensionsFrom(raw, view, offset, extEnd, gitdir);
    const trailer = raw.subarray(extEnd);
    return { entries, entriesByteLength, extensions, trailer };
  });

/** Read + parse `<gitdir>/index`. Honors mtime cache (caller passes via cache). */
export const readIndex = Effect.fn('readIndex')(function* (gitdir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const file = path.join(gitdir, 'index');
  const raw = yield* fs.readFile(file).pipe(
    Effect.catchAll((cause) =>
      Effect.fail(
        new IndexCorruptError({
          gitdir,
          reason: 'read-failed',
          message: `failed to read ${file}: ${cause.message}`,
        })
      )
    )
  );
  return yield* parseIndexV2(gitdir, raw);
});
