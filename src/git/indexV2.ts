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
import * as Schema from 'effect/Schema';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
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

const HEX = '0123456789abcdef';
const oidFromBytes = (bytes: Uint8Array): Oid => {
  // eslint-disable-next-line functional/no-let
  let out = '';
  for (let i = 0; i < 20; i += 1) {
    const b = bytes[i] ?? 0;
    out += HEX[b >>> 4] ?? '';
    out += HEX[b & 0x0f] ?? '';
  }
  return Schema.decodeUnknownSync(Oid)(out);
};

const ASCII = new TextDecoder('utf-8', { fatal: false });

const corrupt = (reason: string, gitdir: string): IndexCorruptError =>
  new IndexCorruptError({ gitdir, reason, message: `index v2 parse: ${reason}` });

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

    // eslint-disable-next-line functional/no-let
    let offset = HEADER_BYTES;
    const entries: IndexEntry[] = [];
    // eslint-disable-next-line functional/no-loop-statements
    for (let i = 0; i < entryCount; i += 1) {
      const start = offset;
      if (offset + ENTRY_FIXED_BYTES > raw.byteLength - TRAILER_BYTES) {
        throw corrupt(`entry ${i} fixed-fields overflow at offset ${offset}`, gitdir);
      }
      const ctimeSec = view.getUint32(offset, false);
      const ctimeNsec = view.getUint32(offset + 4, false);
      const mtimeSec = view.getUint32(offset + 8, false);
      const mtimeNsec = view.getUint32(offset + 12, false);
      const dev = view.getUint32(offset + 16, false);
      const ino = view.getUint32(offset + 20, false);
      const mode = view.getUint32(offset + 24, false);
      const uid = view.getUint32(offset + 28, false);
      const gid = view.getUint32(offset + 32, false);
      const size = view.getUint32(offset + 36, false);
      const oid = oidFromBytes(raw.subarray(offset + 40, offset + 60));
      const flags = view.getUint16(offset + 60, false);
      const assumeValid = (flags & 0x80_00) !== 0;
      const extended = (flags & 0x40_00) !== 0;
      if (extended) throw corrupt(`entry ${i} sets extended flag (v3 only)`, gitdir);
      const stage = ((flags >> 12) & 0x3) as 0 | 1 | 2 | 3;
      const nameLen = flags & 0x0f_ff;
      offset += ENTRY_FIXED_BYTES;
      // path can exceed 0xfff; in that case nameLen is 0xfff and we scan
      // until NUL.
      const pathStart = offset;
      // eslint-disable-next-line functional/no-let
      let pathEnd = nameLen === 0x0f_ff ? -1 : offset + nameLen;
      if (pathEnd === -1) {
        // eslint-disable-next-line functional/no-let
        let scan = offset;
        // eslint-disable-next-line functional/no-loop-statements
        while (scan < raw.byteLength - TRAILER_BYTES && raw[scan] !== 0) scan += 1;
        pathEnd = scan;
      }
      if (pathEnd > raw.byteLength - TRAILER_BYTES) throw corrupt(`entry ${i} path overflow`, gitdir);
      const pathBytes = raw.subarray(pathStart, pathEnd);
      const decodedPath = ASCII.decode(pathBytes);
      offset = pathEnd; // currently sits on the NUL
      // pad to 8-byte boundary from `start`. v2 stores at least one NUL.
      const total = offset - start;
      const pad = 8 - (total % 8);
      offset += pad;
      entries.push({
        path: decodedPath,
        oid,
        mode,
        stage,
        assumeValid,
        stat: { ctimeSec, ctimeNsec, mtimeSec, mtimeNsec, dev, ino, uid, gid, size },
      });
    }
    const entriesByteLength = offset - HEADER_BYTES;

    // Extensions, until 20 bytes from end.
    const extEnd = raw.byteLength - TRAILER_BYTES;
    const extensions: Array<{ readonly signature: string; readonly payload: Uint8Array }> = [];
    // eslint-disable-next-line functional/no-loop-statements
    while (offset < extEnd) {
      if (offset + 8 > extEnd) throw corrupt('truncated extension header', gitdir);
      const signature = ASCII.decode(raw.subarray(offset, offset + 4));
      const size = view.getUint32(offset + 4, false);
      offset += 8;
      if (offset + size > extEnd) throw corrupt(`extension ${signature} payload overflow`, gitdir);
      const payload = raw.subarray(offset, offset + size);
      extensions.push({ signature, payload });
      offset += size;
    }
    if (offset !== extEnd) throw corrupt(`extension parse stopped at ${offset}, expected ${extEnd}`, gitdir);
    const trailer = raw.subarray(extEnd);
    return { entries, entriesByteLength, extensions, trailer };
  });

/** Read + parse `<gitdir>/index`. Honors mtime cache (caller passes via cache). */
export const readIndex = (gitdir: string): Effect.Effect<IndexV2, IndexCorruptError, FileSystem | Path> =>
  Effect.gen(function* () {
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
