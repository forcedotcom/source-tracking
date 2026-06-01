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
import * as Clock from 'effect/Clock';
import * as Schema from 'effect/Schema';
import { SystemError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { type Capabilities, CapabilitiesTag } from './capabilities';
import { IndexCorruptError, WorkdirIoError } from './errors';
import { hashLooseObject, writeLooseObject } from './objects';
import { readDirectRef, readHead, writeDirectRef, writeSymbolicHead } from './refs';
import { type Author, Oid, RefName, type SwitchCfg } from './schemas';

const ENCODER = new TextEncoder();
const EMPTY_TREE_OID: Oid = Schema.decodeUnknownSync(Oid)('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
const MAIN_REF: RefName = Schema.decodeUnknownSync(RefName)('refs/heads/main');

const isNotFound = (cause: unknown): boolean => cause instanceof SystemError && cause.reason === 'NotFound';

const exists = (file: string) =>
  FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs
        .exists(file)
        .pipe(
          Effect.catchAll((cause) =>
            isNotFound(cause) ? Effect.succeed(false) : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
          )
        )
    )
  );

const writeFile = Effect.fn('writeFile')(function* (file: string, bytes: Uint8Array) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  yield* fs
    .makeDirectory(path.dirname(file), { recursive: true })
    .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(path.dirname(file), cause))));
  yield* fs
    .writeFile(file, bytes)
    .pipe(Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(file, cause))));
});

/** Format a timestamp as `<seconds> +0000` (lite always uses UTC). */
const fmtTs = (ms: number): string => `${Math.floor(ms / 1000)} +0000`;

/**
 * Build an initial commit body: tree + author + committer + message. The
 * trailing empty line yields a final LF after the message — required to
 * match real-git's commit serialization (e.g. `init\n`, not bare `init`).
 */
const buildInitialCommitBody = (treeOid: Oid, author: Author, ts: string, message: string): Uint8Array =>
  ENCODER.encode(
    [
      `tree ${treeOid}`,
      `author ${author.name} <${author.email}> ${ts}`,
      `committer ${author.name} <${author.email}> ${ts}`,
      '',
      message,
      '',
    ].join('\n')
  );

/** Default `core.untrackedCache` is rendered iff capabilities allow it. */
const buildConfig = (untrackedCache: boolean): Uint8Array =>
  ENCODER.encode(
    untrackedCache
      ? '[core]\n\trepositoryformatversion = 0\n\tuntrackedCache = true\n'
      : '[core]\n\trepositoryformatversion = 0\n'
  );

const SHADOW_AUTHOR_DEFAULT: Author = {
  name: 'sfdx source tracking',
  email: 'source-tracking@noreply.salesforce.com',
};

export type InitArgs = {
  readonly cfg: SwitchCfg;
  readonly author?: Author;
  readonly message?: string;
  /** Override the timestamp for tests. Defaults to Clock.currentTimeMillis. */
  readonly timestampMs?: number;
};

/**
 * `init` for a shadow repo. Idempotent over a valid existing shadow:
 * a missing .git/ triggers a full write per the manifest below; HEAD plus
 * refs/heads/main plus objects/ all present is a no-op; partial state
 * (e.g. HEAD present but refs/heads/main missing) raises IndexCorruptError
 * and never overwrites.
 *
 * Writes:
 * .git/HEAD ("ref: refs/heads/main\n"), .git/objects/4b/825dc6... (the
 * empty-tree object, zlib of `tree 0\0`), .git/objects/<a..b>/<rest>
 * (initial commit), .git/refs/heads/main ("<initial-commit-oid>\n"),
 * .git/info/exclude (empty; caller sets via setInfoExclude), .git/config
 * (minimal `[core] repositoryformatversion = 0`, plus `untrackedCache =
 * true` if capabilities support it).
 */
export const init = Effect.fn('init')(function* (args: InitArgs) {
  const path = yield* Path;
  const capabilities = yield* CapabilitiesTag;
  const { cfg } = args;
  const author = args.author ?? SHADOW_AUTHOR_DEFAULT;
  const message = args.message ?? 'init';
  const timestampMs = args.timestampMs ?? (yield* Clock.currentTimeMillis);

  const [headExists, mainExists, objectsExists] = yield* Effect.all(
    [
      exists(path.join(cfg.gitdir, 'HEAD')),
      exists(path.join(cfg.gitdir, 'refs', 'heads', 'main')),
      exists(path.join(cfg.gitdir, 'objects')),
    ],
    { concurrency: 'unbounded' }
  );

  const fail = (reason: string, msg: string) =>
    Effect.fail(new IndexCorruptError({ gitdir: cfg.gitdir, reason, message: msg }));

  // Idempotency: valid shadow → no-op (return existing HEAD oid).
  return yield* headExists && mainExists && objectsExists
    ? readDirectRef(cfg.gitdir, MAIN_REF).pipe(
        Effect.catchTag('RefNotFoundError', (cause) =>
          fail(
            'main-ref-readback-failed',
            `init found a shadow at ${cfg.gitdir} but could not read refs/heads/main: ${cause.message}`
          )
        )
      )
    : headExists !== mainExists || (headExists && !objectsExists)
    ? fail(
        'partial-shadow',
        `init refuses to overwrite partial shadow at ${cfg.gitdir} (HEAD=${headExists}, refs/heads/main=${mainExists}, objects/=${objectsExists})`
      )
    : freshInit({
        cfg,
        author,
        message,
        timestampMs,
        infoExcludePath: path.join(cfg.gitdir, 'info', 'exclude'),
        configPath: path.join(cfg.gitdir, 'config'),
        capabilities,
      });
});

const freshInit = Effect.fn('freshInit')(function* (a: {
  readonly cfg: SwitchCfg;
  readonly author: Author;
  readonly message: string;
  readonly timestampMs: number;
  readonly infoExcludePath: string;
  readonly configPath: string;
  readonly capabilities: Capabilities;
}) {
  const fail = (reason: string, message: string) =>
    Effect.fail(new IndexCorruptError({ gitdir: a.cfg.gitdir, reason, message }));

  // 1. empty-tree object. Sanity-check our hash impl against the canonical.
  const emptyTreeOid = yield* writeLooseObject(a.cfg.gitdir, 'tree', new Uint8Array(0));
  yield* emptyTreeOid === EMPTY_TREE_OID
    ? Effect.void
    : fail('empty-tree-oid-mismatch', `init: hashed empty tree to ${emptyTreeOid}, expected ${EMPTY_TREE_OID}`);

  // 2. initial commit + sanity-check that hashLooseObject agrees.
  const commitBody = buildInitialCommitBody(emptyTreeOid, a.author, fmtTs(a.timestampMs), a.message);
  const commitOid = yield* writeLooseObject(a.cfg.gitdir, 'commit', commitBody);
  const hashed = yield* hashLooseObject('commit', commitBody);
  yield* hashed === commitOid
    ? Effect.void
    : fail('commit-oid-mismatch', `init: writeLooseObject returned ${commitOid} but hashLooseObject says ${hashed}`);

  // 3. refs/heads/main → commit oid; 4. HEAD → ref: refs/heads/main.
  yield* writeDirectRef(a.cfg.gitdir, MAIN_REF, commitOid);
  yield* writeSymbolicHead(a.cfg.gitdir, MAIN_REF);

  // 5. info/exclude (empty) — only if absent. Caller mutates via setInfoExclude.
  const excludeExists = yield* exists(a.infoExcludePath);
  yield* excludeExists ? Effect.void : writeFile(a.infoExcludePath, new Uint8Array(0));

  // 6. config.
  yield* writeFile(a.configPath, buildConfig(a.capabilities.supportsUntr));

  // Sanity: HEAD must resolve back to a symbolic ref pointing at main.
  const verified = yield* readHead(a.cfg.gitdir).pipe(
    Effect.catchAll((cause) => fail('head-readback-failed', `init: HEAD readback failed: ${cause.message}`))
  );
  return yield* verified.kind === 'symbolic' && verified.target === MAIN_REF
    ? Effect.succeed(commitOid)
    : fail('head-readback-mismatch', 'init: HEAD did not round-trip to symbolic ref refs/heads/main');
});
