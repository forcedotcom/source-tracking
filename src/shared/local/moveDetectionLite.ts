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

/*
 * Lite move-detection. Same algorithm as the iso path: match adds against
 * deletes by basename + content hash + metadata type. The whole pipeline is
 * Effect-native and pipes start to end:
 *
 *   parallel { drain HEAD oids;  hash workdir adds }
 *     -> bucket each side by composite key
 *     -> emit telemetry for collisions
 *     -> intersect on full key  -> fullMatches
 *     -> intersect on hashless key over the leftovers -> deleteOnly
 *
 * Key perf delta vs. iso: iso did N `git.readBlob` calls (one per deleted
 * file). Lite drains `Repo.streamHeadTree()` ONCE into a HashMap and looks
 * up. With thousands of deletes that's one stream pass instead of N.
 */

import path from 'node:path';
import { Logger, Lifecycle } from '@salesforce/core';
import {
  MetadataResolver,
  RegistryAccess,
  type SourceComponent,
  VirtualTreeContainer,
} from '@salesforce/source-deploy-retrieve';
import { FileSystem } from '@effect/platform/FileSystem';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as HashSet from 'effect/HashSet';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import { Repo } from '../../git/repo';
import { WorkdirIoError } from '../../git/errors';
import { hashBlob } from '../../git/objects';
import { uniqueArrayConcat } from '../functions';
import { ensurePosix, IS_WINDOWS } from './functions';
import type { DetectionFileInfo, DetectionFileInfoWithType } from './types';

// =============================== types ====================================

/**
 * What the consumer actually needs to act on detected moves: a count, the
 * two file lists for `commitChanges`, and a pre-formatted log line.
 * HashMap stays internal to this module.
 */
type MoveDetectionResult = {
  readonly count: number;
  readonly deployedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly logMessage: string;
};

const emptyResult: MoveDetectionResult = {
  count: 0,
  deployedFiles: [],
  deletedFiles: [],
  logMessage: '',
};

type StringMapsForMatches = {
  readonly fullMatches: HashMap.HashMap<string, string>;
  readonly deleteOnly: HashMap.HashMap<string, string>;
};

type AddAndDeleteHashMaps = {
  readonly addedMap: HashMap.HashMap<string, string>;
  readonly deletedMap: HashMap.HashMap<string, string>;
};

/**
 * Bucket = the result of grouping one side (adds OR deletes) by composite
 * key. `map` is `key -> filename` for keys seen exactly once. `ignored` is
 * `key -> filename` for keys we hit more than once: when two files on the
 * same side share basename + hash + type + parent, we can't tell which is
 * which, so we drop both candidates and surface a telemetry event.
 *
 * The match phase intersects the two sides' `map`s; `ignored` exists
 * solely so the telemetry tap can count collisions before it's dropped.
 */
type Bucket = {
  readonly map: HashMap.HashMap<string, string>;
  readonly ignored: HashMap.HashMap<string, string>;
};

// =============================== entry point ==============================

const emptyBucket: Bucket = { map: HashMap.empty(), ignored: HashMap.empty() };

/**
 * Run the lite move-detection pipeline. Stream-shaped end to end: each side
 * is one Stream<DetectionFileInfoWithType> that runs into a Bucket via
 * `Stream.runFold` (single materialization point). The HEAD-tree drain
 * runs in parallel with workdir hashing; bucketing runs in parallel for
 * each side; collision telemetry is a Tap on the bucket struct.
 *
 * Empty-side fast path: if either side has no candidates, no commit is
 * possible — return an empty result without touching the filesystem.
 *
 * Returns a `MoveDetectionResult` shaped for the caller's `commitChanges`
 * call: file lists + count + a pre-formatted log line. The internal
 * HashMaps don't leak across the module boundary.
 */
export const filenameMatchesToMapLite =
  (registry: RegistryAccess) =>
  (projectPath: string) =>
  (fdPermits: number) =>
  ({ added, deleted }: { added: ReadonlySet<string>; deleted: ReadonlySet<string> }) => {
    if (added.size === 0 || deleted.size === 0) return Effect.succeed(emptyResult);
    const enrich = enrichStream(
      new MetadataResolver(
        registry,
        VirtualTreeContainer.fromFilePaths(uniqueArrayConcat(Array.from(added), Array.from(deleted)))
      )
    );
    // Both bucket Effects sit at the same level so Effect.all races them.
    // The deleted side's stream waits on drainHeadOids; the added side
    // doesn't, so it can start hashing while HEAD is still being walked.
    const addedBucket = Stream.runFold(
      addedInfoStream(projectPath, fdPermits, added).pipe(enrich),
      emptyBucket,
      accumulateBucket
    );
    const deletedBucket = drainHeadOids().pipe(
      Effect.flatMap((headOids) =>
        Stream.runFold(deletedInfoStream(headOids, deleted).pipe(enrich), emptyBucket, accumulateBucket)
      )
    );
    return Effect.all({ added: addedBucket, deleted: deletedBucket }, { concurrency: 'unbounded' }).pipe(
      Effect.tap((b) => emitCollisionTelemetry(HashMap.size(b.added.ignored) + HashMap.size(b.deleted.ignored))),
      Effect.map(({ added: a, deleted: d }) => ({ addedMap: a.map, deletedMap: d.map } satisfies AddAndDeleteHashMaps)),
      Effect.map(compareHashes),
      Effect.map(toMoveDetectionResult)
    );
  };

/**
 * Project the internal HashMap-shaped match result onto the consumer's
 * `MoveDetectionResult` shape: count + file lists + log line.
 */
const toMoveDetectionResult = ({ fullMatches, deleteOnly }: StringMapsForMatches): MoveDetectionResult => {
  const count = HashMap.size(fullMatches) + HashMap.size(deleteOnly);
  if (count === 0) return emptyResult;
  return {
    count,
    deployedFiles: Array.from(HashMap.keys(fullMatches)),
    deletedFiles: [...Array.from(HashMap.values(fullMatches)), ...Array.from(HashMap.values(deleteOnly))],
    logMessage: [
      'Files have moved. Committing moved files:',
      ...Array.from(HashMap.entries(fullMatches), ([add, del]) => `- File ${del} was moved to ${add}`),
      ...Array.from(HashMap.entries(deleteOnly), ([add, del]) => `- File ${del} was moved to ${add} and modified`),
    ].join('\n'),
  };
};

// =============================== gather streams ==========================

/**
 * Stream<DetectionFileInfo> for workdir adds. fdPermits caps the read+hash
 * concurrency; backpressure flows through to bucketing downstream.
 */
const addedInfoStream = (projectPath: string, fdPermits: number, added: ReadonlySet<string>) =>
  Stream.fromIterable(added).pipe(
    Stream.mapEffect(
      (filepath) => {
        const abs = path.join(projectPath, filepath);
        return FileSystem.pipe(
          Effect.flatMap((fs) => fs.readFile(abs)),
          Effect.catchAll((cause) => Effect.fail(WorkdirIoError.fromPlatformError(abs, cause))),
          Effect.flatMap(hashBlob),
          Effect.map(
            (hash) => ({ filename: filepath, basename: path.basename(filepath), hash } satisfies DetectionFileInfo)
          )
        );
      },
      { concurrency: fdPermits }
    )
  );

/**
 * Stream<DetectionFileInfo> for deletes. The file is gone on disk, so we
 * look up the oid recorded in HEAD; paths absent from HEAD drop via
 * filterMap.
 */
const deletedInfoStream = (headOids: HashMap.HashMap<string, string>, deleted: ReadonlySet<string>) =>
  Stream.fromIterable(deleted).pipe(Stream.filterMap(lookupDeleted(headOids)));

/** Drain HEAD tree once into a path→oid HashMap. Replaces N readBlob calls. */
const drainHeadOids = Effect.fn('moveDetectionLite.drainHeadOids')(function* () {
  const repo = yield* Repo;
  return yield* repo.streamHeadTree().pipe(
    Stream.map((p) => [p.path, p.oid] as const),
    Stream.runCollect,
    Effect.map(HashMap.fromIterable)
  );
});

const lookupDeleted =
  (headOids: HashMap.HashMap<string, string>) =>
  (filepath: string): Option.Option<DetectionFileInfo> =>
    HashMap.get(headOids, IS_WINDOWS ? ensurePosix(filepath) : filepath).pipe(
      Option.map((hash) => ({ filename: filepath, basename: path.basename(filepath), hash }))
    );

// =============================== type-resolution stream ==================

/**
 * Resolve a single filename through SDR's MetadataResolver. SDR can throw
 * on unresolvable paths; wrap once and convert to an empty array so the
 * stream just emits nothing for that filename.
 */
const resolveOne = (resolver: MetadataResolver, filename: string): SourceComponent[] => {
  // eslint-disable-next-line functional/no-try-statements -- SDR throws on unresolvable; log and emit nothing.
  try {
    return resolver.getComponentsFromPath(filename);
  } catch {
    Logger.childFromRoot('ShadowRepo.compareTypes').warn(`unable to resolve ${filename}`);
    return [];
  }
};

/**
 * Stream operator: for each `DetectionFileInfo`, emit one
 * `DetectionFileInfoWithType` per resolved metadata component (0..N).
 */
const enrichStream =
  (resolver: MetadataResolver) =>
  <E, R>(s: Stream.Stream<DetectionFileInfo, E, R>): Stream.Stream<DetectionFileInfoWithType, E, R> =>
    Stream.mapConcat(s, (info) =>
      resolveOne(resolver, info.filename).map((c) => ({
        ...info,
        type: c.type.name,
        parentType: c.parent?.type.name ?? '',
        parentFullName: c.parent?.fullName ?? '',
      }))
    );

// =============================== bucket fold =============================

/**
 * `Stream.runFold` step: accumulate one entry into the bucket. Duplicate
 * keys go to `ignored`; unique keys land in `map`.
 */
const accumulateBucket = ({ map, ignored }: Bucket, i: DetectionFileInfoWithType): Bucket => {
  const key = toKey(i);
  return HashMap.has(map, key) || HashMap.has(ignored, key)
    ? { map: HashMap.remove(map, key), ignored: HashMap.set(ignored, key, i.filename) }
    : { map: HashMap.set(map, key, i.filename), ignored };
};

// =============================== telemetry side effect ===================

const COLLISION_MESSAGE =
  'Files were found that have the same basename, hash, metadata type, and parent. Skipping the commit of these files';

const emitCollisionTelemetry = Effect.fn('moveDetectionLite.emitCollisionTelemetry')(function* (collisions: number) {
  if (collisions === 0) return;
  Logger.childFromRoot('ShadowRepo.compareHashes').warn(COLLISION_MESSAGE);
  const lifecycle = Lifecycle.getInstance();
  yield* Effect.promise(() =>
    Promise.all([
      lifecycle.emitWarning(COLLISION_MESSAGE),
      lifecycle.emitTelemetry({ eventName: 'moveFileHashBasenameCollisionsDetected' }),
    ])
  );
});

// =============================== match phase =============================

/**
 * Intersect two HashMaps on their keys; for each shared key build
 * `[fromAdded, fromDeleted]` so we get an `add->del` map suitable for the
 * commitChanges call. Used twice: once on the full key, once on the
 * hashless key after dropping fullMatches.
 */
const intersectByKey = (
  a: HashMap.HashMap<string, string>,
  b: HashMap.HashMap<string, string>
): HashMap.HashMap<string, string> =>
  HashMap.keySet(a).pipe(
    HashSet.intersection(HashMap.keySet(b)),
    HashSet.map((k) => [HashMap.unsafeGet(a, k), HashMap.unsafeGet(b, k)] as const),
    HashMap.fromIterable
  );

const reKey = (m: HashMap.HashMap<string, string>): HashMap.HashMap<string, string> =>
  m.pipe(HashMap.reduce(HashMap.empty<string, string>(), (acc, v, k) => HashMap.set(acc, removeHashFromKey(k), v)));

const compareHashes = ({ addedMap, deletedMap }: AddAndDeleteHashMaps): StringMapsForMatches => {
  const fullMatches = intersectByKey(addedMap, deletedMap);
  const matchedKeys = HashMap.keySet(fullMatches);
  const remainingAdds = HashMap.removeMany(addedMap, matchedKeys);
  const remainingDeletes = HashMap.removeMany(deletedMap, matchedKeys);
  // matchedKeys held the FULL keys; intersectByKey on fullMatches above
  // produced add->del pairs. The leftover sides still hold full keys, so
  // strip the hash component before the second intersection.
  return HashMap.size(remainingAdds) === 0 || HashMap.size(remainingDeletes) === 0
    ? { fullMatches, deleteOnly: HashMap.empty() }
    : { fullMatches, deleteOnly: intersectByKey(reKey(remainingAdds), reKey(remainingDeletes)) };
};

// =============================== key serialization =======================

const JOIN_CHAR = '#__#';

const toKey = (input: DetectionFileInfoWithType): string =>
  [input.hash, input.basename, input.type, input.type, input.parentType ?? '', input.parentFullName ?? ''].join(
    JOIN_CHAR
  );

const removeHashFromKey = (hash: string): string => hash.split(JOIN_CHAR).splice(1).join(JOIN_CHAR);
