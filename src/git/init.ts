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
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { CapabilitiesTag } from './capabilities';
import { IndexCorruptError, WorkdirIoError } from './errors';
import { hashLooseObject, writeLooseObject } from './objects';
import { readDirectRef, readHead, writeDirectRef, writeSymbolicHead } from './refs';
import { type Author, type CommitOid, Oid, RefName, type SwitchCfg } from './schemas';

const ENCODER = new TextEncoder();
const EMPTY_TREE_OID: Oid = Schema.decodeUnknownSync(Oid)('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
const MAIN_REF: RefName = Schema.decodeUnknownSync(RefName)('refs/heads/main');

const isNotFound = (cause: { readonly _tag: string; readonly reason?: string }): boolean =>
  // eslint-disable-next-line no-underscore-dangle
  cause._tag === 'SystemError' && cause.reason === 'NotFound';

const exists = (file: string): Effect.Effect<boolean, WorkdirIoError, FileSystem> =>
  FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs
        .exists(file)
        .pipe(
          Effect.catchAll(
            (cause): Effect.Effect<boolean, WorkdirIoError> =>
              isNotFound(cause as never)
                ? Effect.succeed(false)
                : Effect.fail(WorkdirIoError.fromPlatformError(file, cause))
          )
        )
    )
  );

const writeFile = (file: string, bytes: Uint8Array): Effect.Effect<void, WorkdirIoError, FileSystem | Path> =>
  Effect.gen(function* () {
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

/** Build an initial commit body: tree + author + committer + message. */
const buildInitialCommitBody = (treeOid: Oid, author: Author, ts: string, message: string): Uint8Array => {
  const lines = [
    `tree ${treeOid}`,
    `author ${author.name} <${author.email}> ${ts}`,
    `committer ${author.name} <${author.email}> ${ts}`,
    '',
    message,
  ];
  // Trailing LF after the message is required to match real-git's commit
  // serialization (e.g. `init\n`, not bare `init`).
  return ENCODER.encode(`${lines.join('\n')}\n`);
};

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
export const init = (
  args: InitArgs
): Effect.Effect<CommitOid, IndexCorruptError | WorkdirIoError, FileSystem | Path | CapabilitiesTag> =>
  Effect.gen(function* () {
    const path = yield* Path;
    const capabilities = yield* CapabilitiesTag;
    const { cfg } = args;
    const author = args.author ?? SHADOW_AUTHOR_DEFAULT;
    const message = args.message ?? 'init';
    const timestampMs = args.timestampMs ?? (yield* Clock.currentTimeMillis);

    const headPath = path.join(cfg.gitdir, 'HEAD');
    const mainPath = path.join(cfg.gitdir, 'refs', 'heads', 'main');
    const objectsDir = path.join(cfg.gitdir, 'objects');
    const infoExcludePath = path.join(cfg.gitdir, 'info', 'exclude');
    const configPath = path.join(cfg.gitdir, 'config');

    const headExists = yield* exists(headPath);
    const mainExists = yield* exists(mainPath);
    const objectsExists = yield* exists(objectsDir);

    // Idempotency: valid shadow → no-op (return existing HEAD oid).
    if (headExists && mainExists && objectsExists) {
      return yield* readDirectRef(cfg.gitdir, MAIN_REF).pipe(
        Effect.catchTag('RefNotFoundError', (cause) =>
          Effect.fail(
            new IndexCorruptError({
              gitdir: cfg.gitdir,
              reason: 'main-ref-readback-failed',
              message: `init found a shadow at ${cfg.gitdir} but could not read refs/heads/main: ${cause.message}`,
            })
          )
        )
      );
    }

    // Partial state: refuse to overwrite — user has either an in-flight
    // crash or external mutation, and clobbering risks data loss.
    if (headExists !== mainExists || (headExists && !objectsExists)) {
      return yield* Effect.fail(
        new IndexCorruptError({
          gitdir: cfg.gitdir,
          reason: 'partial-shadow',
          message: `init refuses to overwrite partial shadow at ${cfg.gitdir} (HEAD=${headExists}, refs/heads/main=${mainExists}, objects/=${objectsExists})`,
        })
      );
    }

    // Fresh init.
    // 1. empty-tree object.
    const emptyTreeOid = yield* writeLooseObject(cfg.gitdir, 'tree', new Uint8Array(0));
    if (emptyTreeOid !== EMPTY_TREE_OID) {
      // Defensive: if our hash impl ever drifted from the canonical,
      // surface it loudly. The empty tree's oid is the most-recognized
      // sha1 in git.
      return yield* Effect.fail(
        new IndexCorruptError({
          gitdir: cfg.gitdir,
          reason: 'empty-tree-oid-mismatch',
          message: `init: hashed empty tree to ${emptyTreeOid}, expected ${EMPTY_TREE_OID}`,
        })
      );
    }

    // 2. initial commit.
    const ts = fmtTs(timestampMs);
    const commitBody = buildInitialCommitBody(emptyTreeOid, author, ts, message);
    const commitOid = yield* writeLooseObject(cfg.gitdir, 'commit', commitBody);
    // Sanity-check that hashLooseObject and writeLooseObject agree.
    const hashed = yield* hashLooseObject('commit', commitBody);
    if (hashed !== commitOid) {
      return yield* Effect.fail(
        new IndexCorruptError({
          gitdir: cfg.gitdir,
          reason: 'commit-oid-mismatch',
          message: `init: writeLooseObject returned ${commitOid} but hashLooseObject says ${hashed}`,
        })
      );
    }

    // 3. refs/heads/main → commit oid.
    yield* writeDirectRef(cfg.gitdir, MAIN_REF, commitOid);

    // 4. HEAD → ref: refs/heads/main.
    yield* writeSymbolicHead(cfg.gitdir, MAIN_REF);

    // 5. info/exclude (empty) — only if absent. Caller mutates via
    //    setInfoExclude.
    const excludeExists = yield* exists(infoExcludePath);
    if (!excludeExists) yield* writeFile(infoExcludePath, new Uint8Array(0));

    // 6. config.
    yield* writeFile(configPath, buildConfig(capabilities.supportsUntr));

    // Sanity: HEAD must resolve back to commitOid.
    const verified = yield* readHead(cfg.gitdir).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(
          new IndexCorruptError({
            gitdir: cfg.gitdir,
            reason: 'head-readback-failed',
            message: `init: HEAD readback failed: ${cause.message}`,
          })
        )
      )
    );
    if (verified.kind !== 'symbolic' || verified.target !== MAIN_REF) {
      return yield* Effect.fail(
        new IndexCorruptError({
          gitdir: cfg.gitdir,
          reason: 'head-readback-mismatch',
          message: 'init: HEAD did not round-trip to symbolic ref refs/heads/main',
        })
      );
    }
    return commitOid;
  });
