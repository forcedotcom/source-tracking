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
import { Logger } from '@salesforce/core/logger';
import { isString } from '@salesforce/ts-types';
import {
  MetadataResolver,
  VirtualTreeContainer,
  ForceIgnore,
  RegistryAccess,
} from '@salesforce/source-deploy-retrieve';
import { ChangeResult } from './types';
import { isChangeResultWithNameAndType, isDefined } from './guards';
import {
  ensureRelative,
  excludeLwcLocalOnlyTest,
  forceIgnoreDenies,
  getAllFiles,
  maybeGetTreeContainer,
  sourceComponentHasFullNameAndType,
} from './functions';

/**
 * uses SDR to translate remote metadata records into local file paths (which only typically have the filename).
 *
 * @input elements: ChangeResult[]
 * @input projectPath
 * @input forceIgnore: ForceIgnore.  If provided, result will indicate whether the file is ignored
 * @input excludeUnresolvable: boolean Filter out components where you can't get the name and type (that is, it's probably not a valid source component)
 * @input resolveDeleted: constructs a virtualTree instead of the actual filesystem--useful when the files no longer exist
 */
export const populateTypesAndNames =
  ({
    projectPath,
    forceIgnore,
    excludeUnresolvable = false,
    resolveDeleted = false,
    registry,
  }: {
    projectPath: string;
    forceIgnore?: ForceIgnore;
    excludeUnresolvable?: boolean;
    resolveDeleted?: boolean;
    registry: RegistryAccess;
  }) =>
  async (elements: ChangeResult[]): Promise<ChangeResult[]> => {
    if (elements.length === 0) {
      return [];
    }
    const logger = Logger.childFromRoot('SourceTracking.PopulateTypesAndNames');
    logger.debug(`populateTypesAndNames for ${elements.length} change elements`);
    const filenames = elements.flatMap((element) => element.filenames).filter(isString);

    // component set generated from the filenames on all local changes
    const resolver = new MetadataResolver(
      registry,
      resolveDeleted ? VirtualTreeContainer.fromFilePaths(filenames) : maybeGetTreeContainer(projectPath),
      !!forceIgnore
    );
    const elementMap = new Map(
      elements.flatMap((e) => (e.filenames ?? []).map((f) => [ensureRelative(projectPath)(f), e]))
    );

    // Deduplicate by fullName+type: all files in the same bundle component (e.g. uiBundles)
    // resolve to the same SourceComponent, so without dedup getAllFiles/walkContent is called
    // once per input file rather than once per unique component (O(N) walks instead of O(1)).
    const uniqueSourceComponents = new Map<string, ReturnType<typeof resolver.getComponentsFromPath>[number]>();
    for (const [index, filename] of filenames.entries()) {
      try {
        for (const component of resolver.getComponentsFromPath(filename)) {
          if (isDefined(component) && sourceComponentHasFullNameAndType(component)) {
            uniqueSourceComponents.set(`${component.fullName}:${component.type.name}`, component);
          }
        }
      } catch (e) {
        logger.warn(`unable to resolve ${filename}`);
      }
      if (index > 0 && index % 100 === 0) {
        // Yield only after completing one filename's resolution and deduplication.
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((continueWork) => setImmediate(continueWork));
      }
    }

    logger.debug(`populateTypesAndNames resolved ${uniqueSourceComponents.size} unique components`);

    // iterates the local components and sets their filenames
    for (const [index, matchingComponent] of [...uniqueSourceComponents.values()].entries()) {
      const filenamesFromMatchingComponent = getAllFiles(matchingComponent);
      const ignored = filenamesFromMatchingComponent
        .filter(excludeLwcLocalOnlyTest)
        .some(forceIgnoreDenies(forceIgnore));
      filenamesFromMatchingComponent.forEach((filename) => {
        if (filename && elementMap.has(filename)) {
          // add the type/name from the componentSet onto the element
          elementMap.set(filename, {
            origin: 'remote',
            ...elementMap.get(filename),
            type: matchingComponent.type.name,
            name: matchingComponent.fullName,
            ignored,
          });
        }
      });
      if (index > 0 && index % 100 === 0) {
        // Yield only after all paths belonging to this component are enriched.
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((continueWork) => setImmediate(continueWork));
      }
    }
    return excludeUnresolvable
      ? Array.from(new Set(elementMap.values())).filter(isChangeResultWithNameAndType)
      : Array.from(new Set(elementMap.values()));
  };
