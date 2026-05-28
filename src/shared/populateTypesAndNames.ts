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
 * native Map/Set.
 *
 * Legacy algorithm: O(N) calls to SDR.MetadataResolver.getComponentsFromPath,
 * one per input filename, even though all files in the same bundle resolve to
 * the same SourceComponent. For an N-file project with K unique components,
 * legacy does N resolves + K walkContent calls.
 *
 * Resolve-then-claim: walk filenames in order. For each filename, either skip
 * if it's already in the `claimed` Set (covered by a previously resolved
 * component's getAllFiles), or resolve it, walk the resulting components'
 * content files, and add those files to `claimed`.
 *
 * Result: K resolves + K walkContent calls. For 35k files / ~350 components
 * that's a ~100x reduction in SDR work.
 *
 * Spans emitted: `populateTypesAndNames` (outer). No-op unless the consumer
 * provides a NodeSdk Layer.
 */

type ResolvedEntry = { readonly sc: SourceComponent; readonly files: readonly string[] };
type Patch = Readonly<{ type: string; name: string; ignored: boolean }>;

const tryResolve =
  (resolver: MetadataResolver, logger: Logger) =>
  (filename: string): readonly SourceComponent[] => {
    // eslint-disable-next-line functional/no-try-statements
    try {
      return resolver.getComponentsFromPath(filename);
    } catch {
      logger.warn(`unable to resolve ${filename}`);
      return [];
    }
  };

const claimComponent =
  (state: { claimed: Set<string>; byKey: Map<string, ResolvedEntry> }, relativize: (s: string) => string) =>
  (sc: SourceComponent): void => {
    if (!sourceComponentHasFullNameAndType(sc)) return;
    const key = `${sc.type.name}#${sc.fullName}`;
    if (state.byKey.has(key)) return;
    const relFiles = getAllFiles(sc).filter(isString).map(relativize);
    relFiles.forEach((f) => state.claimed.add(f));
    state.byKey.set(key, { sc, files: relFiles });
  };

const buildEnrichments = (
  byKey: ReadonlyMap<string, ResolvedEntry>,
  forceIgnore: ForceIgnore | undefined
): Map<string, Patch> => {
  const out = new Map<string, Patch>();
  byKey.forEach(({ sc, files }) => {
    const ignored = files.filter(excludeLwcLocalOnlyTest).some(forceIgnoreDenies(forceIgnore));
    const patch: Patch = { type: sc.type.name, name: sc.fullName, ignored };
    files.forEach((f) => out.set(f, patch));
  });
  return out;
};

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

    // Single pass over elements: build the resolver's filename list and the
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

    const claimed = new Set<string>();
    const byKey = new Map<string, ResolvedEntry>();
    const claim = claimComponent({ claimed, byKey }, relativize);
    const resolve = tryResolve(resolver, logger);

    const claimedSkipped = filenames.reduce((skipped, filename) => {
      if (claimed.has(relativize(filename))) return skipped + 1;
      resolve(filename).forEach(claim);
      return skipped;
    }, 0);

    yield* Effect.annotateCurrentSpan({
      elementCount: elements.length,
      uniqueComponentCount: byKey.size,
      claimedSkipped,
    });

    const enrichments = buildEnrichments(byKey, deps.forceIgnore);
    const seen = new Set<ChangeResult>();
    const result = Array.from(elementMap.entries()).flatMap(([f, cr]) => {
      if (seen.has(cr)) return [];
      seen.add(cr);
      const p = enrichments.get(f);
      const merged = p ? { ...cr, ...p } : cr;
      if (deps.excludeUnresolvable && !isChangeResultWithNameAndType(merged)) return [];
      return [merged];
    });

    yield* elCapture.finalize();
    return result;
  });
