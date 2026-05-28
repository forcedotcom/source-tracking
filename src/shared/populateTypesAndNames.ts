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
import * as Stream from 'effect/Stream';
import * as HashMap from 'effect/HashMap';
import * as HashSet from 'effect/HashSet';
import * as Data from 'effect/Data';
import { pipe } from 'effect/Function';
import { Logger } from '@salesforce/core/logger';
import { isString } from '@salesforce/ts-types';
import {
  ForceIgnore,
  MetadataResolver,
  RegistryAccess,
  SourceComponent,
  VirtualTreeContainer,
} from '@salesforce/source-deploy-retrieve';
import { ChangeResult } from './types';
import { isChangeResultWithNameAndType } from './guards';
import { eventLoopDelayCapture } from './eventLoopDelayCapture';
import {
  ensureRelative,
  excludeLwcLocalOnlyTest,
  forceIgnoreDenies,
  getAllFiles,
  maybeGetTreeContainer,
  sourceComponentHasFullNameAndType,
} from './functions';

type Deps = {
  readonly projectPath: string;
  readonly forceIgnore?: ForceIgnore;
  readonly excludeUnresolvable?: boolean;
  readonly resolveDeleted?: boolean;
  readonly registry: RegistryAccess;
};

/**
 * Effect-based populateTypesAndNames using a resolve-then-claim fold over a
 * `Stream` pipeline.
 *
 * Legacy algorithm: O(N) calls to SDR.MetadataResolver.getComponentsFromPath,
 * one per input filename, even though all files in the same bundle resolve to
 * the same SourceComponent. For an N-file project with K unique components,
 * legacy does N resolves + K walkContent calls.
 *
 * Resolve-then-claim: walk filenames in order. For each filename, either
 * skip if it's already in the `claimed` HashSet (covered by a previously
 * resolved component's getAllFiles), or resolve it, walk the resulting
 * components' content files, and add those files to `claimed`.
 *
 * Result: K resolves + K walkContent calls. For 35k files / ~350 components
 * that's a ~100x reduction in SDR work.
 *
 * The `byKey` HashMap is keyed by `Data.struct({ fullName, type })` — Effect
 * derives Equal/Hash from the struct shape, so two components with the same
 * (fullName, type) hash to the same key without manual stringification. The
 * `claimed` HashSet uses plain string keys (relative file paths).
 *
 * Spans emitted: `populateTypesAndNames` (outer). No-op unless the consumer
 * provides a NodeSdk Layer.
 */

type DedupeKey = Readonly<{ fullName: string; type: string }>;
type ResolvedEntry = { readonly sc: SourceComponent; readonly files: readonly string[] };
type Patch = Readonly<{ type: string; name: string; ignored: boolean }>;

type FoldState = {
  readonly claimed: HashSet.HashSet<string>;
  readonly byKey: HashMap.HashMap<DedupeKey, ResolvedEntry>;
  readonly claimedSkipped: number;
};

const emptyState: FoldState = {
  claimed: HashSet.empty<string>(),
  byKey: HashMap.empty<DedupeKey, ResolvedEntry>(),
  claimedSkipped: 0,
};

const resolveOne = (resolver: MetadataResolver, logger: Logger) => (filename: string) =>
  Effect.try((): readonly SourceComponent[] => resolver.getComponentsFromPath(filename)).pipe(
    Effect.tapError(() => Effect.sync(() => logger.warn(`unable to resolve ${filename}`))),
    Effect.orElseSucceed((): readonly SourceComponent[] => [])
  );

const claimComponent = (relativize: (s: string) => string) => (state: FoldState, sc: SourceComponent) =>
  Effect.sync(() => {
    if (!sourceComponentHasFullNameAndType(sc)) return state;
    const key: DedupeKey = Data.struct({ fullName: sc.fullName, type: sc.type.name });
    if (HashMap.has(state.byKey, key)) return state;
    const relFiles = getAllFiles(sc).filter(isString).map(relativize);
    return {
      claimed: relFiles.reduce<HashSet.HashSet<string>>((s, f) => HashSet.add(s, f), state.claimed),
      byKey: HashMap.set(state.byKey, key, { sc, files: relFiles }),
      claimedSkipped: state.claimedSkipped,
    };
  });

const stepFold =
  (resolver: MetadataResolver, logger: Logger, relativize: (s: string) => string) =>
  (state: FoldState, filename: string) =>
    HashSet.has(state.claimed, relativize(filename))
      ? Effect.succeed({ ...state, claimedSkipped: state.claimedSkipped + 1 })
      : pipe(
          resolveOne(resolver, logger)(filename),
          Effect.flatMap((components) => Effect.reduce(components, state, claimComponent(relativize)))
        );

const enrichmentsFromState =
  (forceIgnore: ForceIgnore | undefined) =>
  (state: FoldState): ReadonlyMap<string, Patch> =>
    new Map(
      Array.from(HashMap.values(state.byKey)).flatMap(({ sc, files }) => {
        const ignored = files.filter(excludeLwcLocalOnlyTest).some(forceIgnoreDenies(forceIgnore));
        return files.map((f) => [f, { type: sc.type.name, name: sc.fullName, ignored }] as const);
      })
    );

/**
 * Wrap a ChangeResult with `Data.struct` (and `Data.array` for `filenames`) so
 * it carries Effect's `Equal`/`Hash` traits — that lets HashSet dedupe by
 * structural equality instead of object identity. Type stays `ChangeResult`
 * (Schema-derived); the Data symbols are invisible to consumers.
 */
const toData = (cr: ChangeResult): ChangeResult =>
  Data.struct({
    ...cr,
    filenames: cr.filenames ? Data.array(cr.filenames) : undefined,
  });

const applyAndDedupe =
  (elementMap: ReadonlyMap<string, ChangeResult>) =>
  (enrichments: ReadonlyMap<string, Patch>): HashSet.HashSet<ChangeResult> =>
    HashSet.fromIterable(
      Array.from(elementMap.entries()).map(([f, cr]) => {
        const p = enrichments.get(f);
        return toData(p ? { ...cr, ...p } : cr);
      })
    );

const maybeFilter =
  (excludeUnresolvable: boolean) =>
  (set: HashSet.HashSet<ChangeResult>): HashSet.HashSet<ChangeResult> =>
    excludeUnresolvable ? HashSet.filter(set, isChangeResultWithNameAndType) : set;

export const populateTypesAndNames = (deps: Deps) =>
  Effect.fn('populateTypesAndNames')(function* (elements: readonly ChangeResult[]) {
    const elCapture = eventLoopDelayCapture();
    if (elements.length === 0) {
      yield* elCapture.finalize();
      return [] as ChangeResult[];
    }

    const logger = Logger.childFromRoot('SourceTracking.PopulateTypesAndNames');
    logger.debug(`populateTypesAndNames for ${elements.length} change elements`);

    const relativize = ensureRelative(deps.projectPath);

    // Single pass over elements: flatten to (filename, relativeFilename, element)
    // triples so we can derive both the resolver's filename list and the
    // filename→element lookup map without iterating `elements` twice.
    const triples = elements.flatMap((e) =>
      (e.filenames ?? []).filter(isString).map((f) => [f, relativize(f), e] as const)
    );
    const filenames = triples.map(([f]) => f);
    const elementMap = new Map(triples.map(([, rel, e]) => [rel, e] as const));

    const resolver = new MetadataResolver(
      deps.registry,
      deps.resolveDeleted ? VirtualTreeContainer.fromFilePaths(filenames) : maybeGetTreeContainer(deps.projectPath),
      !!deps.forceIgnore
    );

    const fold = stepFold(resolver, logger, relativize);

    const finalState = yield* pipe(Stream.fromIterable(filenames), Stream.runFoldEffect(emptyState, fold));

    yield* Effect.annotateCurrentSpan({
      elementCount: elements.length,
      uniqueComponentCount: HashMap.size(finalState.byKey),
      claimedSkipped: finalState.claimedSkipped,
    });

    const result = yield* pipe(
      Effect.succeed(finalState),
      Effect.map(enrichmentsFromState(deps.forceIgnore)),
      Effect.map(applyAndDedupe(elementMap)),
      Effect.map(maybeFilter(!!deps.excludeUnresolvable)),
      Effect.map(HashSet.toValues)
    );
    yield* elCapture.finalize();
    return result;
  });
