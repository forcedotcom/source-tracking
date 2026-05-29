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
import { hashLooseObject, writeLooseObject } from './objects';
import { Oid } from './schemas';
import type { IndexEntry } from './indexV2';

const TEXT = new TextEncoder();

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
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i] ?? '';
      // eslint-disable-next-line functional/no-let
      let next = node.subtrees.get(seg);
      if (next === undefined) {
        next = newTreeNode();
        node.subtrees.set(seg, next);
      }
      node = next;
    }
    const leaf = segs[segs.length - 1] ?? '';
    node.entries.set(leaf, { mode: f.mode, oid: f.oid });
  }
  return root;
};

/**
 * Real-git's tree-entry sort: each directory entry is suffixed with `/` for
 * comparison. This keeps `foo` and `foo.txt` and `foo/...` ordering correct.
 */
const compareTreeName = (a: string, aIsTree: boolean, b: string, bIsTree: boolean): number => {
  const ka = aIsTree ? `${a}/` : a;
  const kb = bIsTree ? `${b}/` : b;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** Encode one tree object body. Recursively writes subtrees first (bottom-up). */
const writeTreeObject = (gitdir: string, node: TreeMapNode): Effect.Effect<Oid, never, never> =>
  // The complex Effect typing above is too noisy; just rely on inference:
  Effect.gen(function* () {
    // 1. Recurse into subtrees, get their oids.
    const subOids = new Map<string, Oid>();
    // eslint-disable-next-line functional/no-loop-statements
    for (const [name, sub] of node.subtrees) {
      const subOid = yield* writeTreeObject(gitdir, sub);
      subOids.set(name, subOid);
    }
    // 2. Build the entry list: files + subtree-oids, sorted by canonical name.
    type Entry = { name: string; mode: number; oid: Oid; isTree: boolean };
    const all: Entry[] = [];
    node.entries.forEach((e, name) => all.push({ name, mode: e.mode, oid: e.oid, isTree: false }));
    subOids.forEach((oid, name) => all.push({ name, mode: 0o040000, oid, isTree: true }));
    all.sort((a, b) => compareTreeName(a.name, a.isTree, b.name, b.isTree));
    // 3. Encode: `<mode-octal-no-padding> <name>\0<20-byte-oid>` repeated.
    const parts: Uint8Array[] = [];
    all.forEach((e) => {
      parts.push(TEXT.encode(`${e.mode.toString(8)} ${e.name}\0`));
      parts.push(oidToBytes(e.oid));
    });
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const body = new Uint8Array(total);
    // eslint-disable-next-line functional/no-let
    let off = 0;
    parts.forEach((p) => {
      body.set(p, off);
      off += p.byteLength;
    });
    return yield* writeLooseObject(gitdir, 'tree', body);
  }) as never;

export const writeTreeFromMap = writeTreeObject;

// =================== INDEX V2 WRITER ===================

const HEADER_BYTES = 12;
const ENTRY_FIXED_BYTES = 62;

/** Encode one index entry; pads to 8-byte alignment from the entry start. */
const encodeIndexEntry = (e: IndexEntry): Uint8Array => {
  const pathBytes = TEXT.encode(e.path);
  const nameLen = Math.min(pathBytes.byteLength, 0x0fff);
  const flags = (e.assumeValid ? 0x8000 : 0) | ((e.stage & 0x3) << 12) | (nameLen & 0x0fff);
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

/**
 * Build index v2 bytes from a sorted entry list. Caller is responsible for
 * passing entries in real-git canonical order (path-byte-wise sort).
 * Extensions are appended verbatim from the optional `extensions` arg
 * (TREE/UNTR/etc — phase 11 wires UNTR here).
 */
export const writeIndexV2 = (
  entries: readonly IndexEntry[],
  extensions: ReadonlyArray<{ readonly signature: string; readonly payload: Uint8Array }> = []
): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const header = new Uint8Array(HEADER_BYTES);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x44_49_52_43, false); // DIRC
    headerView.setUint32(4, 2, false); // version 2
    headerView.setUint32(8, sorted.length, false);
    const entryBytes = sorted.map(encodeIndexEntry);
    const extBytes: Uint8Array[] = extensions.map((ext) => {
      const out = new Uint8Array(8 + ext.payload.byteLength);
      const sig = TEXT.encode(ext.signature.padEnd(4, ' ').slice(0, 4));
      out.set(sig, 0);
      new DataView(out.buffer).setUint32(4, ext.payload.byteLength, false);
      out.set(ext.payload, 8);
      return out;
    });
    const body = concat([header, ...entryBytes, ...extBytes]);
    const trailer = await sha1(body);
    return concat([body, trailer]);
  });

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
  readonly parent: Oid | null;
  readonly author: { readonly name: string; readonly email: string };
  readonly tsSeconds: number;
  readonly message: string;
};

export const writeCommit = (gitdir: string, args: CommitArgs): Effect.Effect<Oid, never, never> =>
  Effect.gen(function* () {
    const ts = `${args.tsSeconds} +0000`;
    const lines = [
      `tree ${args.tree}`,
      ...(args.parent ? [`parent ${args.parent}`] : []),
      `author ${args.author.name} <${args.author.email}> ${ts}`,
      `committer ${args.author.name} <${args.author.email}> ${ts}`,
      '',
      args.message,
    ];
    const body = TEXT.encode(`${lines.join('\n')}\n`);
    return yield* writeLooseObject(gitdir, 'commit', body);
  }) as never;

/** Hash a tree map without writing — for callers that want the oid first. */
export const hashTreeFromMap = (node: TreeMapNode): Effect.Effect<Oid> =>
  Effect.gen(function* () {
    const subOids = new Map<string, Oid>();
    // eslint-disable-next-line functional/no-loop-statements
    for (const [name, sub] of node.subtrees) {
      const subOid = yield* hashTreeFromMap(sub);
      subOids.set(name, subOid);
    }
    type Entry = { name: string; mode: number; oid: Oid; isTree: boolean };
    const all: Entry[] = [];
    node.entries.forEach((e, name) => all.push({ name, mode: e.mode, oid: e.oid, isTree: false }));
    subOids.forEach((oid, name) => all.push({ name, mode: 0o040000, oid, isTree: true }));
    all.sort((a, b) => compareTreeName(a.name, a.isTree, b.name, b.isTree));
    const parts: Uint8Array[] = [];
    all.forEach((e) => {
      parts.push(TEXT.encode(`${e.mode.toString(8)} ${e.name}\0`));
      parts.push(oidToBytes(e.oid));
    });
    return yield* hashLooseObject('tree', concat(parts));
  });

// keep Schema import used (decode in tests via re-export)
void Schema;
