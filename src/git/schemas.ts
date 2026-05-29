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
import * as Schema from 'effect/Schema';

const HEX_40 = /^[0-9a-f]{40}$/;

// branded oid (40-hex sha1)
export const Oid = Schema.String.pipe(
  Schema.pattern(HEX_40, { message: () => 'oid must be a lowercase 40-character sha1' }),
  Schema.brand('@source-tracking/Oid')
);
export type Oid = Schema.Schema.Type<typeof Oid>;

// branded posix workdir-relative path; normalized + .. rejected
const REJECTED_SEGMENTS = new Set(['', '.', '..']);

const validateRepoPath = (raw: string): string | undefined => {
  if (raw.length === 0) return 'path must not be empty';
  if (raw.startsWith('/')) return 'path must be workdir-relative (no leading "/")';
  if (raw.includes('\\')) return 'path must be posix-normalized (no backslashes)';
  if (raw.includes('\0')) return 'path must not contain NUL';
  const segments = raw.split('/');
  return segments.some((s) => REJECTED_SEGMENTS.has(s)) ? 'path must not contain "", "." or ".." segments' : undefined;
};

export const RepoPath = Schema.String.pipe(
  Schema.filter((raw) => validateRepoPath(raw) ?? true),
  Schema.brand('@source-tracking/RepoPath')
);
export type RepoPath = Schema.Schema.Type<typeof RepoPath>;

// branded ref name (e.g. "refs/heads/main", "HEAD")
const REF_PATTERN = /^(?:HEAD|refs\/[A-Za-z0-9_./-]+)$/;
export const RefName = Schema.String.pipe(
  Schema.pattern(REF_PATTERN, { message: () => 'refName must be "HEAD" or "refs/<path>"' }),
  Schema.brand('@source-tracking/RefName')
);
export type RefName = Schema.Schema.Type<typeof RefName>;

// public StatusEntry, see test/git/STATUS-COLLAPSE.md
export const StatusEntry = Schema.Struct({
  path: RepoPath,
  status: Schema.Literal('unmodified', 'modified', 'added', 'deleted', 'ignored'),
});
export type StatusEntry = Schema.Schema.Type<typeof StatusEntry>;

// commit / shadow author. lite stamps the timestamp from Clock; the schema
// here is the input shape callers hand to applyChanges/init.
export const Author = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  email: Schema.String.pipe(Schema.minLength(1)),
});
export type Author = Schema.Schema.Type<typeof Author>;

// SwitchCfg is what callers pass to switchTo / init. Roots and fdPermits are
// properties of the handle; they change only via another switchTo.
export const SwitchCfg = Schema.Struct({
  dir: Schema.String.pipe(Schema.minLength(1)),
  gitdir: Schema.String.pipe(Schema.minLength(1)),
  roots: Schema.Array(RepoPath),
  fdPermits: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
});
export type SwitchCfg = Schema.Schema.Type<typeof SwitchCfg>;

// CommitOid is the result of applyChanges / init.
export type CommitOid = Oid;
