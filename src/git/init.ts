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
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { IndexCorruptError } from './errors.js';
import { writeLooseObject } from './objects.js';
import { withIndexLock } from './lock.js';
import { writeCommit } from './writers.js';
import { readDirectRef, readHead, writeDirectRef, writeSymbolicHead } from './refs.js';
import { type Author, Oid, RefName, type RepoConfig } from './schemas.js';
import { lstat } from './workdir.js';

const ENCODER = new TextEncoder();
const EMPTY_TREE_OID: Oid = Schema.decodeUnknownSync(Oid)('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
const MAIN_REF: RefName = Schema.decodeUnknownSync(RefName)('refs/heads/main');

const exists = (file: string) =>
  FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.exists(file).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(false)))
    )
  );

const readStringOrEmpty = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed('')));
});

const readDirectoryOrEmpty = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem;
  return yield* fs
    .readDirectory(directory)
    .pipe(Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed([] satisfies string[])));
});

const isRegularFile = (file: string) =>
  lstat(file).pipe(
    Effect.map((info) => info.isFile()),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(false))
  );

const isDirectory = (directory: string) =>
  lstat(directory).pipe(
    Effect.map((info) => info.isDirectory()),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(false))
  );

const hasExactly = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && expected.every((name) => actual.includes(name));

const ISOMORPHIC_EMPTY_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = false',
  '\tbare = false',
  '\tlogallrefupdates = true',
  '\tsymlinks = false',
  '\tignorecase = true',
  '',
].join('\n');

type LegacyEmptyRepoLayout = Readonly<{
  head: string;
  config: string;
  gitdirEntries: readonly string[];
  hooksEntries: readonly string[];
  infoEntries: readonly string[];
  objectDirs: readonly string[];
  objectInfoEntries: readonly string[];
  objectPackEntries: readonly string[];
  refsEntries: readonly string[];
  headsEntries: readonly string[];
  tagsEntries: readonly string[];
  headFile: boolean;
  configFile: boolean;
  hooksDirectory: boolean;
  infoDirectory: boolean;
  objectsDirectory: boolean;
  objectInfoDirectory: boolean;
  objectPackDirectory: boolean;
  refsDirectory: boolean;
  headsDirectory: boolean;
  tagsDirectory: boolean;
  infoExcludeFile: boolean;
}>;

const hasLegacyDirectoryEntries = (layout: LegacyEmptyRepoLayout): boolean =>
  hasExactly(layout.gitdirEntries, ['HEAD', 'config', 'hooks', 'info', 'objects', 'refs']) &&
  hasExactly(layout.hooksEntries, []) &&
  hasExactly(layout.refsEntries, ['heads', 'tags']);

const hasLegacyInfoEntries = (layout: LegacyEmptyRepoLayout): boolean =>
  hasExactly(layout.infoEntries, []) || (hasExactly(layout.infoEntries, ['exclude']) && layout.infoExcludeFile);

const hasEmptyLegacyObjects = (layout: LegacyEmptyRepoLayout): boolean =>
  hasExactly(layout.objectDirs, ['info', 'pack']) &&
  hasExactly(layout.objectInfoEntries, []) &&
  hasExactly(layout.objectPackEntries, []);

const hasEmptyLegacyRefs = (layout: LegacyEmptyRepoLayout): boolean =>
  hasExactly(layout.headsEntries, []) && hasExactly(layout.tagsEntries, []);

const hasLegacyFilesystemTypes = (layout: LegacyEmptyRepoLayout): boolean =>
  layout.headFile &&
  layout.configFile &&
  layout.hooksDirectory &&
  layout.infoDirectory &&
  layout.objectsDirectory &&
  layout.objectInfoDirectory &&
  layout.objectPackDirectory &&
  layout.refsDirectory &&
  layout.headsDirectory &&
  layout.tagsDirectory;

const isLegacyEmptyRepoLayout = (layout: LegacyEmptyRepoLayout): boolean =>
  layout.head === `ref: ${MAIN_REF}\n` &&
  layout.config === ISOMORPHIC_EMPTY_CONFIG &&
  hasLegacyDirectoryEntries(layout) &&
  hasLegacyInfoEntries(layout) &&
  hasEmptyLegacyObjects(layout) &&
  hasEmptyLegacyRefs(layout) &&
  hasLegacyFilesystemTypes(layout);

/** Recognize only the exact empty gitdir created by isomorphic-git 1.44.2. */
const isLegacyEmptyIsomorphicRepo = Effect.fnUntraced(function* (gitdir: string) {
  const path = yield* Path;
  const objects = path.join(gitdir, 'objects');
  const info = path.join(gitdir, 'info');
  const refs = path.join(gitdir, 'refs');
  const layout = yield* Effect.all(
    {
      head: readStringOrEmpty(path.join(gitdir, 'HEAD')),
      config: readStringOrEmpty(path.join(gitdir, 'config')),
      gitdirEntries: readDirectoryOrEmpty(gitdir).pipe(
        Effect.map((entries) => entries.filter((name) => name !== 'index.lock'))
      ),
      hooksEntries: readDirectoryOrEmpty(path.join(gitdir, 'hooks')),
      infoEntries: readDirectoryOrEmpty(info),
      objectDirs: readDirectoryOrEmpty(objects),
      objectInfoEntries: readDirectoryOrEmpty(path.join(objects, 'info')),
      objectPackEntries: readDirectoryOrEmpty(path.join(objects, 'pack')),
      refsEntries: readDirectoryOrEmpty(refs),
      headsEntries: readDirectoryOrEmpty(path.join(refs, 'heads')),
      tagsEntries: readDirectoryOrEmpty(path.join(refs, 'tags')),
      headFile: isRegularFile(path.join(gitdir, 'HEAD')),
      configFile: isRegularFile(path.join(gitdir, 'config')),
      hooksDirectory: isDirectory(path.join(gitdir, 'hooks')),
      infoDirectory: isDirectory(info),
      objectsDirectory: isDirectory(objects),
      objectInfoDirectory: isDirectory(path.join(objects, 'info')),
      objectPackDirectory: isDirectory(path.join(objects, 'pack')),
      refsDirectory: isDirectory(refs),
      headsDirectory: isDirectory(path.join(refs, 'heads')),
      tagsDirectory: isDirectory(path.join(refs, 'tags')),
      infoExcludeFile: isRegularFile(path.join(info, 'exclude')),
    },
    { concurrency: 'unbounded' }
  );
  return isLegacyEmptyRepoLayout(layout);
});

const writeFile = Effect.fn('writeFile')(function* (file: string, bytes: Uint8Array) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFile(file, bytes);
});

const buildConfig = (): Uint8Array => ENCODER.encode('[core]\n\trepositoryformatversion = 0\n');

const SHADOW_AUTHOR_DEFAULT: Author = {
  name: 'sfdx source tracking',
  email: 'source-tracking@noreply.salesforce.com',
};

export type InitArgs = {
  readonly cfg: RepoConfig;
  readonly author?: Author;
  readonly message?: string;
  /** Override the timestamp for tests. Defaults to Clock.currentTimeMillis. */
  readonly timestampMs?: number;
};

/**
 * `init` for a shadow repo. Idempotent over a valid existing shadow:
 * a missing .git/ triggers a full write per the manifest below; HEAD plus
 * refs/heads/main plus objects/ all present is a no-op. An empty isomorphic-git
 * initialization is upgraded with an initial commit. Other partial state
 * raises IndexCorruptError and is never overwritten.
 *
 * Writes:
 * .git/HEAD ("ref: refs/heads/main\n"), .git/objects/4b/825dc6... (the
 * empty-tree object, zlib of `tree 0\0`), .git/objects/<a..b>/<rest>
 * (initial commit), .git/refs/heads/main ("<initial-commit-oid>\n"),
 * .git/info/exclude (empty; caller sets via setInfoExclude), .git/config
 * (minimal `[core] repositoryformatversion = 0`).
 */
const initialize = Effect.fnUntraced(function* (args: InitArgs) {
  const path = yield* Path;
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
  const legacyEmpty =
    headExists && !mainExists && objectsExists ? yield* isLegacyEmptyIsomorphicRepo(cfg.gitdir) : false;
  const freshArgs = {
    cfg,
    author,
    message,
    timestampMs,
    infoExcludePath: path.join(cfg.gitdir, 'info', 'exclude'),
    configPath: path.join(cfg.gitdir, 'config'),
  };

  // Idempotency: valid shadow → no-op (return existing HEAD oid).
  return yield* legacyEmpty
    ? freshInit(freshArgs)
    : headExists && mainExists && objectsExists
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
    : freshInit(freshArgs);
});

const freshInit = Effect.fn('freshInit')(function* (a: {
  readonly cfg: RepoConfig;
  readonly author: Author;
  readonly message: string;
  readonly timestampMs: number;
  readonly infoExcludePath: string;
  readonly configPath: string;
}) {
  const fail = (reason: string, message: string) =>
    Effect.fail(new IndexCorruptError({ gitdir: a.cfg.gitdir, reason, message }));

  // 1. empty-tree object. Sanity-check our hash impl against the canonical.
  const emptyTreeOid = yield* writeLooseObject(a.cfg.gitdir, 'tree', new Uint8Array(0));
  yield* emptyTreeOid === EMPTY_TREE_OID
    ? Effect.void
    : fail('empty-tree-oid-mismatch', `init: hashed empty tree to ${emptyTreeOid}, expected ${EMPTY_TREE_OID}`);

  const commitOid = yield* writeCommit(a.cfg.gitdir, {
    tree: emptyTreeOid,
    parent: Option.none(),
    author: a.author,
    tsSeconds: Math.floor(a.timestampMs / 1000),
    message: a.message,
  });

  // 3. refs/heads/main → commit oid; 4. HEAD → ref: refs/heads/main.
  yield* writeDirectRef(a.cfg.gitdir, MAIN_REF, commitOid);
  yield* writeSymbolicHead(a.cfg.gitdir, MAIN_REF);

  // 5. info/exclude (empty) — only if absent. Caller mutates via setInfoExclude.
  yield* exists(a.infoExcludePath).pipe(
    Effect.flatMap((excludeExists) => (excludeExists ? Effect.void : writeFile(a.infoExcludePath, new Uint8Array(0))))
  );

  // 6. config.
  yield* writeFile(a.configPath, buildConfig());

  // Sanity: HEAD must resolve back to a symbolic ref pointing at main.
  const verified = yield* readHead(a.cfg.gitdir).pipe(
    Effect.catch((cause) => fail('head-readback-failed', `init: HEAD readback failed: ${cause.message}`))
  );
  return yield* verified.kind === 'symbolic' && verified.target === MAIN_REF
    ? Effect.succeed(commitOid)
    : fail('head-readback-mismatch', 'init: HEAD did not round-trip to symbolic ref refs/heads/main');
});

/** @internal */
export const init = Effect.fn('init')(function* (args: InitArgs) {
  const fs = yield* FileSystem;
  yield* fs.makeDirectory(args.cfg.gitdir, { recursive: true });
  return yield* initialize(args).pipe(withIndexLock(args.cfg.gitdir));
});
