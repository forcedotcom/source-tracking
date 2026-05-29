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
import { ObjectCorruptError, ObjectNotFoundError, WorkdirIoError } from './errors';
import { Oid } from './schemas';

export const LooseObjectType = Schema.Literal('blob', 'tree', 'commit');
export type LooseObjectType = Schema.Schema.Type<typeof LooseObjectType>;
const LOOSE_OBJECT_TYPES = new Set<LooseObjectType>(LooseObjectType.literals);

/**
 * A decoded loose object: type discriminator + raw content bytes. Pairs
 * with the framing helpers `frameLooseObject` (encode) and
 * `parseLooseObject` (decode).
 */
export const LooseObject = Schema.Struct({
  type: LooseObjectType,
  content: Schema.instanceOf(Uint8Array),
});
export type LooseObject = Schema.Schema.Type<typeof LooseObject>;

const TEXT = new TextEncoder();
const ASCII_DECODER = new TextDecoder('ascii', { fatal: false });
const SP = 0x20;
const NUL = 0x00;
const HEX = '0123456789abcdef';

/**
 * Lowercase hex encoding of a Uint8Array. Avoids `Buffer` so the same code
 * path works in the web bundle.
 */
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => `${HEX[b >>> 4] ?? ''}${HEX[b & 0x0f] ?? ''}`).join('');

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  // eslint-disable-next-line functional/no-let
  let offset = 0;
  parts.forEach((p) => {
    out.set(p, offset);
    offset += p.byteLength;
  });
  return out;
};

const sha1Hex = (bytes: Uint8Array) =>
  Effect.promise(() =>
    crypto.subtle.digest('SHA-1', bytes as unknown as ArrayBuffer).then((buf) => toHex(new Uint8Array(buf)))
  );

/**
 * Stream-API-based zlib deflate using web-platform CompressionStream.
 * Node 22+ and modern browsers both expose this. No `node:zlib` import.
 */
const transform = async (bytes: Uint8Array, ts: GenericTransformStream): Promise<Uint8Array> => {
  const stream = new Response(bytes as unknown as BodyInit).body!.pipeThrough(
    ts as unknown as ReadableWritablePair<unknown, Uint8Array>
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
};

const deflate = (bytes: Uint8Array) => Effect.promise(() => transform(bytes, new CompressionStream('deflate')));

const inflate = (bytes: Uint8Array) => Effect.promise(() => transform(bytes, new DecompressionStream('deflate')));

/**
 * Hash a blob with git's loose-object framing: `blob <size>\0<content>`.
 * Public API; pure function over bytes, no fs.
 */
export const hashBlob = Effect.fn('hashBlob')(function* (bytes: Uint8Array) {
  const framed = frameLooseObject('blob', bytes);
  const hex = yield* sha1Hex(framed);
  return Schema.decodeUnknownSync(Oid)(hex);
});

/**
 * Hash arbitrary loose-object framing (tree, commit). Internal helper used
 * by phases 5 and 9.
 */
export const hashLooseObject = Effect.fn('hashLooseObject')(function* (type: LooseObjectType, content: Uint8Array) {
  const framed = frameLooseObject(type, content);
  const hex = yield* sha1Hex(framed);
  return Schema.decodeUnknownSync(Oid)(hex);
});

const frameLooseObject = (type: LooseObjectType, content: Uint8Array): Uint8Array => {
  const header = TEXT.encode(`${type} ${content.byteLength}\0`);
  return concat([header, content]);
};

const looseObjectPath = (path: Path, gitdir: string, oid: Oid): { dir: string; file: string } => {
  const dir = path.join(gitdir, 'objects', oid.slice(0, 2));
  const file = path.join(dir, oid.slice(2));
  return { dir, file };
};

/**
 * Write a loose object: zlib-deflate `<type> <size>\0<content>`, place at
 * `.git/objects/<oid[0:2]>/<oid[2:]>`. Idempotent — git is content-addressed,
 * so re-writing the same content over a pre-existing oid is harmless.
 */
export const writeLooseObject = Effect.fn('writeLooseObject')(function* (
  gitdir: string,
  type: LooseObjectType,
  content: Uint8Array
) {
  const fs = yield* FileSystem;
  const path = yield* Path;

  const framed = frameLooseObject(type, content);
  const oid = yield* hashLooseObject(type, content);
  const { dir, file } = looseObjectPath(path, gitdir, oid);

  // Skip the write if the object already exists (cheap idempotency for the
  // hot path where applyChanges re-stages identical files).
  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (exists) return oid;

  const compressed = yield* deflate(framed);
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(dir, cause))));
  yield* fs
    .writeFile(file, compressed)
    .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(file, cause))));
  return oid;
});

/**
 * Read a loose object by oid. Verifies the sha after inflating. Missing path
 * → ObjectNotFoundError; truncated/malformed → ObjectCorruptError.
 */
export const readLooseObject = Effect.fn('readLooseObject')(function* (gitdir: string, oid: Oid) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const { file } = looseObjectPath(path, gitdir, oid);

  const compressed = yield* fs.readFile(file).pipe(
    Effect.catchTags({
      SystemError: (cause) =>
        cause.reason === 'NotFound'
          ? Effect.fail(new ObjectNotFoundError({ oid, message: `loose object ${oid} not found at ${file}` }))
          : Effect.fail(
              new ObjectCorruptError({
                oid,
                reason: cause.reason,
                message: `loose object ${oid} read failed: ${cause.message}`,
              })
            ),
      BadArgument: (cause) =>
        Effect.fail(
          new ObjectCorruptError({
            oid,
            reason: 'BadArgument',
            message: `loose object ${oid} read failed: ${cause.message}`,
          })
        ),
    })
  );

  const inflated = yield* inflate(compressed);
  const parsed = parseLooseObject(oid, inflated);
  if (parsed.kind === 'corrupt') return yield* Effect.fail(parsed.error);

  // verify the sha matches the framed content
  const verifiedHex = yield* sha1Hex(inflated);
  if (verifiedHex !== oid) {
    return yield* Effect.fail(
      new ObjectCorruptError({
        oid,
        reason: 'sha1 mismatch',
        message: `loose object ${oid} content hashes to ${verifiedHex}`,
      })
    );
  }
  return { type: parsed.type, content: parsed.content };
});

type ParseResult =
  | { readonly kind: 'ok'; readonly type: LooseObjectType; readonly content: Uint8Array }
  | { readonly kind: 'corrupt'; readonly error: ObjectCorruptError };

const parseLooseObject = (oid: Oid, framed: Uint8Array): ParseResult => {
  // header form: "<type> <size>\0" — find SP and NUL
  const spIx = framed.indexOf(SP);
  if (spIx < 0) {
    return {
      kind: 'corrupt',
      error: new ObjectCorruptError({ oid, reason: 'no header SP', message: `${oid}: malformed header` }),
    };
  }
  const nulIx = framed.indexOf(NUL, spIx + 1);
  if (nulIx < 0) {
    return {
      kind: 'corrupt',
      error: new ObjectCorruptError({ oid, reason: 'no header NUL', message: `${oid}: malformed header` }),
    };
  }
  const typeStr = ASCII_DECODER.decode(framed.subarray(0, spIx));
  const sizeStr = ASCII_DECODER.decode(framed.subarray(spIx + 1, nulIx));
  if (!LOOSE_OBJECT_TYPES.has(typeStr as LooseObjectType)) {
    return {
      kind: 'corrupt',
      error: new ObjectCorruptError({
        oid,
        reason: `unknown type "${typeStr}"`,
        message: `${oid}: unknown object type`,
      }),
    };
  }
  const declaredSize = Number(sizeStr);
  const content = framed.subarray(nulIx + 1);
  if (!Number.isInteger(declaredSize) || declaredSize !== content.byteLength) {
    return {
      kind: 'corrupt',
      error: new ObjectCorruptError({
        oid,
        reason: 'size mismatch',
        message: `${oid}: header declared size ${sizeStr}, content is ${content.byteLength}`,
      }),
    };
  }
  return { kind: 'ok', type: typeStr as LooseObjectType, content };
};
