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
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { ObjectCorruptError, ObjectNotFoundError, WorkdirIoError } from './errors.js';
import { Oid } from './schemas.js';

export const LooseObjectType = Schema.Literals(['blob', 'tree', 'commit']);
export type LooseObjectType = Schema.Schema.Type<typeof LooseObjectType>;
const LOOSE_OBJECT_TYPES: ReadonlySet<string> = new Set(LooseObjectType.literals);
const isLooseObjectType = (s: string): s is LooseObjectType => LOOSE_OBJECT_TYPES.has(s);

/**
 * A decoded loose object: type discriminator + raw content bytes. Pairs
 * with the framing helpers `frameLooseObject` (encode) and
 * `parseLooseObject` (decode). Kept as a Schema.Struct so future call
 * sites can decode through Schema if they need validation.
 */
const LooseObjectSchema = Schema.Struct({
  type: LooseObjectType,
  content: Schema.instanceOf(Uint8Array),
});
void LooseObjectSchema;

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
    // TS 5.7+: Uint8Array<ArrayBufferLike> isn't assignable to BufferSource
    // (which requires ArrayBufferView<ArrayBuffer>). Threading the narrower
    // type parameter through every caller is impractical for a slice/subarray.
    crypto.subtle.digest('SHA-1', bytes as unknown as ArrayBuffer).then((buf) => toHex(new Uint8Array(buf)))
  );

/**
 * Stream-API-based zlib deflate using web-platform CompressionStream.
 * Node 22+ and modern browsers both expose this. No `node:zlib` import.
 */
const transform = async (bytes: Uint8Array, ts: GenericTransformStream): Promise<Uint8Array> => {
  // TS 5.7+: same Uint8Array<ArrayBufferLike> vs BodyInit mismatch as sha1Hex.
  // GenericTransformStream lacks the Uint8Array chunk-type Response() needs,
  // so the pipeThrough arg also needs a cast to the typed pair.
  const stream = new Response(bytes as unknown as BodyInit).body!.pipeThrough(ts);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
};

const deflate = (bytes: Uint8Array) => Effect.promise(() => transform(bytes, new CompressionStream('deflate')));

const inflate = (bytes: Uint8Array) => Effect.promise(() => transform(bytes, new DecompressionStream('deflate')));

/**
 * Hash a blob with git's loose-object framing: `blob <size>\0<content>`.
 * Pure function over bytes; no filesystem dependency. Internal to the Git service.
 *
 * @internal
 */
export const hashBlob = Effect.fn('hashBlob')(function* (bytes: Uint8Array) {
  return Schema.decodeUnknownSync(Oid)(yield* sha1Hex(frameLooseObject('blob', bytes)));
});

/**
 * Hash arbitrary loose-object framing (tree, commit). Internal helper used
 * by phases 5 and 9.
 */
// fnUntraced: per-file in hot paths (every staged add, tree write).
// Parent applyChanges/writeTreeFromMap spans carry the meaningful timing.
/** @internal */
export const hashLooseObject = Effect.fnUntraced(function* (type: LooseObjectType, content: Uint8Array) {
  return Schema.decodeUnknownSync(Oid)(yield* sha1Hex(frameLooseObject(type, content)));
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
// fnUntraced: per-file in hot paths. Parent applyChanges/writeTreeFromMap
// spans carry the meaningful timing; per-file spans are noise at scale.
/** @internal */
export const writeLooseObject = Effect.fnUntraced(function* (
  gitdir: string,
  type: LooseObjectType,
  content: Uint8Array
) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const oid = yield* hashLooseObject(type, content);
  const { dir, file } = looseObjectPath(path, gitdir, oid);

  // Skip the write if the object already exists (cheap idempotency for the
  // hot path where applyChanges re-stages identical files).
  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (exists) return oid;

  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(dir, cause))));
  yield* fs
    .writeFile(file, yield* deflate(frameLooseObject(type, content)))
    .pipe(Effect.catch((cause) => Effect.fail(WorkdirIoError.fromPlatformError(file, cause))));
  return oid;
});

/**
 * Read a loose object by oid. Verifies the sha after inflating. Missing path
 * → ObjectNotFoundError; truncated/malformed → ObjectCorruptError.
 */
/** @internal */
export const readLooseObject = Effect.fn('readLooseObject')(function* (gitdir: string, oid: Oid) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const { file } = looseObjectPath(path, gitdir, oid);

  const compressed = yield* fs.readFile(file).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () =>
      Effect.fail(new ObjectNotFoundError({ oid, message: `loose object ${oid} not found at ${file}` }))
    ),
    Effect.catchTag('PlatformError', (cause) =>
      Effect.fail(
        new ObjectCorruptError({
          oid,
          // `_tag` distinguishes SystemError from BadArgument.
          // eslint-disable-next-line no-underscore-dangle
          reason: cause.reason._tag,
          message: `loose object ${oid} read failed: ${cause.message}`,
        })
      )
    )
  );

  const inflated = yield* inflate(compressed);
  const parsed = parseLooseObject(oid, inflated);
  if (parsed.kind === 'corrupt') return yield* parsed.error;
  const verifiedHex = yield* sha1Hex(inflated);
  return verifiedHex === oid
    ? { type: parsed.type, content: parsed.content }
    : yield* new ObjectCorruptError({
        oid,
        reason: 'sha1 mismatch',
        message: `loose object ${oid} content hashes to ${verifiedHex}`,
      });
});

type ParseResult =
  | { readonly kind: 'ok'; readonly type: LooseObjectType; readonly content: Uint8Array }
  | { readonly kind: 'corrupt'; readonly error: ObjectCorruptError };

const corrupt = (oid: Oid, reason: string, message: string): ParseResult => ({
  kind: 'corrupt',
  error: new ObjectCorruptError({ oid, reason, message }),
});

const parseLooseObject = (oid: Oid, framed: Uint8Array): ParseResult => {
  // header form: "<type> <size>\0" — find SP and NUL
  const spIx = framed.indexOf(SP);
  const nulIx = spIx < 0 ? -1 : framed.indexOf(NUL, spIx + 1);
  const typeStr = spIx < 0 ? '' : ASCII_DECODER.decode(framed.subarray(0, spIx));
  const sizeStr = spIx < 0 || nulIx < 0 ? '' : ASCII_DECODER.decode(framed.subarray(spIx + 1, nulIx));
  const declaredSize = Number(sizeStr);
  const content = nulIx < 0 ? new Uint8Array(0) : framed.subarray(nulIx + 1);
  return spIx < 0
    ? corrupt(oid, 'no header SP', `${oid}: malformed header`)
    : nulIx < 0
    ? corrupt(oid, 'no header NUL', `${oid}: malformed header`)
    : !isLooseObjectType(typeStr)
    ? corrupt(oid, `unknown type "${typeStr}"`, `${oid}: unknown object type`)
    : !Number.isInteger(declaredSize) || declaredSize !== content.byteLength
    ? corrupt(oid, 'size mismatch', `${oid}: header declared size ${sizeStr}, content is ${content.byteLength}`)
    : { kind: 'ok', type: typeStr, content };
};
