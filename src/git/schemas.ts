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
export const Oid = Schema.String.check(
  Schema.isPattern(HEX_40, { message: 'oid must be a lowercase 40-character sha1' })
).pipe(Schema.brand('@source-tracking/Oid'));
export type Oid = Schema.Schema.Type<typeof Oid>;

// branded posix workdir-relative path; normalized + .. rejected
const REJECTED_SEGMENTS = new Set(['', '.', '..']);

export const RepoPath = Schema.NonEmptyString.check(
  Schema.makeFilter((s) => !s.startsWith('/'), {
    message: 'path must be workdir-relative (no leading "/")',
  }),
  Schema.makeFilter((s) => !s.includes('\\'), {
    message: 'path must be posix-normalized (no backslashes)',
  }),
  Schema.makeFilter((s) => !s.includes('\0'), { message: 'path must not contain NUL' }),
  Schema.makeFilter((s) => !s.split('/').some((seg) => REJECTED_SEGMENTS.has(seg)), {
    message: 'path must not contain "", "." or ".." segments',
  })
).pipe(Schema.brand('@source-tracking/RepoPath'));
export type RepoPath = Schema.Schema.Type<typeof RepoPath>;

// branded ref name (e.g. "refs/heads/main", "HEAD")
const REF_PATTERN = /^(?:HEAD|refs\/[A-Za-z0-9_./-]+)$/;
export const RefName = Schema.String.check(
  Schema.isPattern(REF_PATTERN, { message: 'refName must be "HEAD" or "refs/<path>"' })
).pipe(Schema.brand('@source-tracking/RefName'));
export type RefName = Schema.Schema.Type<typeof RefName>;

// public StatusEntry, see test/git/STATUS-COLLAPSE.md
export const StatusEntry = Schema.Struct({
  path: RepoPath,
  status: Schema.Literals(['unmodified', 'modified', 'added', 'deleted', 'ignored']),
});
export type StatusEntry = Schema.Schema.Type<typeof StatusEntry>;

// commit / shadow author. lite stamps the timestamp from Clock; the schema
// here is the input shape callers hand to applyChanges/init.
export const Author = Schema.Struct({
  name: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
});
export type Author = Schema.Schema.Type<typeof Author>;

// Each repository layer keeps one immutable set of roots and I/O limits.
export const RepoConfig = Schema.Struct({
  dir: Schema.NonEmptyString,
  gitdir: Schema.NonEmptyString,
  roots: Schema.Array(RepoPath),
  fdPermits: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type RepoConfig = Schema.Schema.Type<typeof RepoConfig>;

// CommitOid is the result of applyChanges / init.
export type CommitOid = Oid;
