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
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as HashSet from 'effect/HashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Schema from 'effect/Schema';
import { type WorkdirIoError } from './errors';
import { hashLooseObject, writeLooseObject } from './objects';
import { Oid } from './schemas';
import type { IndexEntry } from './indexV2';

const TEXT = new TextEncoder();

type TreeBodyEntry = {
  readonly name: string;
  readonly mode: number;
  readonly oid: Oid;
  readonly isTree: boolean;
};

const HEX = '0123456789abcdef';
const oidToBytes = (oid: Oid): Uint8Array => {
  const out = new Uint8Array(20);
  // eslint-disable-next-line functional/no-loop-statements, functional/no-let
  for (let i = 0; i < 20; i += 1) {
    const hi = HEX.indexOf(oid[i * 2] ?? '0');
    const lo = HEX.indexOf(oid[i * 2 + 1] ?? '0');
    out[i] = (hi << 4) | lo;
  }
  return out;
};

const sha1 = async (bytes: Uint8Array): Promise<Uint8Array> => {
  // TS 5.7+ Uint8Array<ArrayBufferLike> vs BufferSource — see objects.ts.
  const buf = await crypto.subtle.digest('SHA-1', bytes as unknown as ArrayBuffer);
  return new Uint8Array(buf);
};

// =================== TREE WRITER ===================

export type TreeMapNode = {
  /** child entries by name, sorted by canonical git tree order. */
  readonly entries: Map<string, { readonly mode: number; readonly oid: Oid }>;
  /** subtree references (subdirs that need their own tree object). */
  readonly subtrees: Map<string, TreeMapNode>;
};

const newTreeNode = (): TreeMapNode => ({ entries: new Map(), subtrees: new Map() });

/**
 * Build a tree-shaped map from a flat (path, mode, oid) iterable.
 * Paths must be posix and not start with `/`. Empty subdirectories are
 * not represented (real-git canonical: trees can't be empty).
 */
export const buildTreeMap = (
  files: Iterable<{ readonly path: string; readonly mode: number; readonly oid: Oid }>
): TreeMapNode => {
  const root = newTreeNode();
  // eslint-disable-next-line functional/no-loop-statements
  for (const f of files) {
    const segs = f.path.split('/');
    // eslint-disable-next-line functional/no-let
    let node = root;
    // eslint-disable-next-line functional/no-loop-statements
    for (const seg of segs.slice(0, -1)) {
      const existing = node.subtrees.get(seg);
      const next = existing ?? newTreeNode();
      if (existing === undefined) node.subtrees.set(seg, next);
      node = next;
    }
    const leaf = segs[segs.length - 1] ?? '';
    node.entries.set(leaf, { mode: f.mode, oid: f.oid });
  }
  return root;
};

/**
 * Real-git's tree-entry sort key: each directory entry is suffixed with `/`
 * so `foo` / `foo.txt` / `foo/...` order correctly under bytewise compare.
 */
const treeSortKey = (e: TreeBodyEntry): string => (e.isTree ? `${e.name}/` : e.name);
const byTreeName: Order.Order<TreeBodyEntry> = Order.mapInput(Order.string, treeSortKey);

/** Encode one tree-object body from a tree-map node's leaves + subtree-oids. */
const buildTreeBody = (
  fileEntries: ReadonlyMap<string, { readonly mode: number; readonly oid: Oid }>,
  subtreeOids: ReadonlyMap<string, Oid>
): Uint8Array =>
  concat(
    Arr.sortBy(byTreeName)([
      ...Arr.fromIterable(fileEntries).map(
        ([name, e]) => ({ name, mode: e.mode, oid: e.oid, isTree: false } satisfies TreeBodyEntry)
      ),
      ...Arr.fromIterable(subtreeOids).map(
        ([name, oid]) => ({ name, mode: 0o04_0000, oid, isTree: true } satisfies TreeBodyEntry)
      ),
    ]).flatMap((e) => [TEXT.encode(`${e.mode.toString(8)} ${e.name}\0`), oidToBytes(e.oid)])
  );

/**
 * Bottom-up: write each subtree object first to obtain its oid, then write
 * the parent tree referencing the children. Uses Effect.gen at the recursive
 * call site (TS can't infer the return type of an `Effect.fn` that recurses
 * into itself) and exposes a non-recursive `Effect.fn` wrapper for the
 * public entry point so traces still show the call.
 */
// Recursive helper: an explicit return type breaks TS's self-reference cycle
// when an Effect-returning function calls itself.
const writeTreeRecursive = (
  gitdir: string,
  node: TreeMapNode
  // eslint-disable-next-line local-rules/no-explicit-effect-return-type
): Effect.Effect<Oid, WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
    const childOids = yield* Effect.forEach(
      Array.from(node.subtrees),
      ([name, sub]) => writeTreeRecursive(gitdir, sub).pipe(Effect.map((oid) => [name, oid] as const)),
      { concurrency: 'unbounded' }
    );
    const subtreeOids = new Map<string, Oid>(childOids);
    return yield* writeLooseObject(gitdir, 'tree', buildTreeBody(node.entries, subtreeOids));
  });

export const writeTreeFromMap = Effect.fn('writeTreeFromMap')(function* (gitdir: string, node: TreeMapNode) {
  return yield* writeTreeRecursive(gitdir, node);
});

// =================== INDEX V2 WRITER ===================

const HEADER_BYTES = 12;
const ENTRY_FIXED_BYTES = 62;

/** Encode one index entry; pads to 8-byte alignment from the entry start. */
const encodeIndexEntry = (e: IndexEntry): Uint8Array => {
  const pathBytes = TEXT.encode(e.path);
  const nameLen = Math.min(pathBytes.byteLength, 0x0f_ff);
  const flags = (e.assumeValid ? 0x80_00 : 0) | ((e.stage & 0x3) << 12) | (nameLen & 0x0f_ff);
  // entry size = fixed + path + at least one NUL + pad to 8
  const minSize = ENTRY_FIXED_BYTES + pathBytes.byteLength + 1; // +1 for NUL terminator
  const padded = Math.ceil(minSize / 8) * 8;
  const out = new Uint8Array(padded);
  const view = new DataView(out.buffer);
  view.setUint32(0, e.stat.ctimeSec, false);
  view.setUint32(4, e.stat.ctimeNsec, false);
  view.setUint32(8, e.stat.mtimeSec, false);
  view.setUint32(12, e.stat.mtimeNsec, false);
  view.setUint32(16, e.stat.dev, false);
  view.setUint32(20, e.stat.ino, false);
  view.setUint32(24, e.mode, false);
  view.setUint32(28, e.stat.uid, false);
  view.setUint32(32, e.stat.gid, false);
  view.setUint32(36, e.stat.size, false);
  out.set(oidToBytes(e.oid), 40);
  view.setUint16(60, flags, false);
  out.set(pathBytes, ENTRY_FIXED_BYTES);
  return out;
};

const byEntryPath: Order.Order<IndexEntry> = Order.mapInput(Order.string, (e: IndexEntry) => e.path);

/**
 * Build index v2 bytes from an entry set. Owns its own canonical sort
 * (path-byte-wise) — callers can pass any HashSet without pre-sorting.
 * Extensions are appended verbatim from the optional `extensions` arg
 * (TREE/UNTR/etc — phase 11 wires UNTR here).
 */
export const writeIndexV2 = (
  entries: HashSet.HashSet<IndexEntry>,
  extensions: ReadonlyArray<{ readonly signature: string; readonly payload: Uint8Array }> = []
) =>
  Effect.promise(async () => {
    const entryBytes = Arr.sortBy(byEntryPath)(entries).map(encodeIndexEntry);
    const header = new Uint8Array(HEADER_BYTES);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x44_49_52_43, false); // DIRC
    headerView.setUint32(4, 2, false); // version 2
    headerView.setUint32(8, entryBytes.length, false);
    const body = concat([header, ...entryBytes, ...extensions.map(encodeExtension)]);
    return concat([body, await sha1(body)]);
  });

const encodeExtension = (ext: { readonly signature: string; readonly payload: Uint8Array }): Uint8Array => {
  const out = new Uint8Array(8 + ext.payload.byteLength);
  out.set(TEXT.encode(ext.signature.padEnd(4, ' ').slice(0, 4)), 0);
  new DataView(out.buffer).setUint32(4, ext.payload.byteLength, false);
  out.set(ext.payload, 8);
  return out;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  // eslint-disable-next-line functional/no-let
  let off = 0;
  parts.forEach((p) => {
    out.set(p, off);
    off += p.byteLength;
  });
  return out;
};

// =================== COMMIT WRITER ===================

export type CommitArgs = {
  readonly tree: Oid;
  readonly parent: Option.Option<Oid>;
  readonly author: { readonly name: string; readonly email: string };
  readonly tsSeconds: number;
  readonly message: string;
};

export const writeCommit = Effect.fn('writeCommit')(function* (gitdir: string, args: CommitArgs) {
  const ts = `${args.tsSeconds} +0000`;
  const body = [
    `tree ${args.tree}`,
    ...Option.match(args.parent, { onNone: (): readonly string[] => [], onSome: (oid) => [`parent ${oid}`] }),
    `author ${args.author.name} <${args.author.email}> ${ts}`,
    `committer ${args.author.name} <${args.author.email}> ${ts}`,
    '',
    args.message,
    '',
  ].join('\n');
  return yield* writeLooseObject(gitdir, 'commit', TEXT.encode(body));
});

// Recursive helper: an explicit return type breaks TS's self-reference cycle.
const hashTreeRecursive = (
  node: TreeMapNode
  // eslint-disable-next-line local-rules/no-explicit-effect-return-type
): Effect.Effect<Oid> =>
  Effect.gen(function* () {
    const childOids = yield* Effect.forEach(
      Array.from(node.subtrees),
      ([name, sub]) => hashTreeRecursive(sub).pipe(Effect.map((oid) => [name, oid] as const)),
      { concurrency: 'unbounded' }
    );
    const subtreeOids = new Map<string, Oid>(childOids);
    return yield* hashLooseObject('tree', buildTreeBody(node.entries, subtreeOids));
  });

/** Hash a tree map without writing — for callers that want the oid first. */
export const hashTreeFromMap = Effect.fn('hashTreeFromMap')(function* (node: TreeMapNode) {
  return yield* hashTreeRecursive(node);
});

// keep Schema import used (decode in tests via re-export)
void Schema;
