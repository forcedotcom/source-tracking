/*
 * Copyright 2025, Salesforce, Inc.
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
import { EOL } from 'node:os';
import { Logger } from '@salesforce/core/logger';
import { ComponentSet, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ChangeResult } from './types.js';
import { isChangeResultWithNameAndType } from './guards.js';
import {
  getAllFiles,
  getKeyFromObject,
  getMetadataKey,
  sourceComponentHasFullNameAndType,
  remoteChangeToMetadataMember,
} from './functions.js';

/**
 * Will build a component set, crawling your local directory, to get paths for remote changes
 *
 * @param elements ChangeResults that may or may not have filepaths in their filenames parameters
 * @param packageDirPaths Array of paths from PackageDirectories
 * @returns
 */
export const populateFilePaths = ({
  elements,
  packageDirPaths,
  registry,
}: {
  elements: ChangeResult[];
  packageDirPaths: string[];
  registry: RegistryAccess;
}): ChangeResult[] => {
  if (elements.length === 0) {
    return [];
  }
  const logger = Logger.childFromRoot('SourceTracking.PopulateFilePaths');
  logger.debug('populateFilePaths for change elements', elements);
  // component set generated from an array of MetadataMember from all the remote changes
  // but exclude the ones that aren't in the registry
  const remoteChangesAsMetadataMember = elements
    .filter(isChangeResultWithNameAndType)
    .map(remoteChangeToMetadataMember);

  const remoteChangesAsComponentSet = new ComponentSet(remoteChangesAsMetadataMember, registry);

  logger.debug(` the generated component set has ${remoteChangesAsComponentSet.size.toString()} items`);
  if (remoteChangesAsComponentSet.size < elements.length) {
    // there *could* be something missing
    // some types (ex: LWC) show up as multiple files in the remote changes, but only one in the component set
    // iterate the elements to see which ones didn't make it into the component set
    const missingComponents = elements
      .filter(isChangeResultWithNameAndType)
      .filter((element) => !remoteChangesAsComponentSet.has({ type: element.type, fullName: element.name }));
    // Throw if anything was actually missing
    if (missingComponents.length > 0) {
      throw new Error(
        `unable to generate complete component set for ${missingComponents
          .map((element) => `${element.name} (${element.type})`)
          .join(EOL)}`
      );
    }
  }

  const matchingLocalSourceComponentsSet = ComponentSet.fromSource({
    fsPaths: packageDirPaths,
    include: remoteChangesAsComponentSet,
    registry,
  });
  logger.debug(
    ` local source-backed component set has ${matchingLocalSourceComponentsSet.size.toString()} items from remote`
  );

  // make it simpler to find things later
  const elementMap = new Map<string, ChangeResult>(elements.map((e) => [getKeyFromObject(e), e]));

  // iterates the local components and sets their filenames
  matchingLocalSourceComponentsSet
    .getSourceComponents()
    .toArray()
    .filter(sourceComponentHasFullNameAndType)
    .map((matchingComponent) => {
      logger.debug(
        `${matchingComponent.fullName}|${matchingComponent.type.name} matches ${
          matchingComponent.xml ?? '<no xml>'
        } and maybe ${matchingComponent.walkContent().toString()}`
      );
      // Decode the key since local components can have encoded fullNames, but results from querying
      // SourceMembers have fullNames that are not encoded. See:  https://github.com/forcedotcom/cli/issues/1683
      const key = decodeURIComponent(getMetadataKey(matchingComponent.type.name, matchingComponent.fullName));
      elementMap.set(key, {
        ...elementMap.get(key),
        modified: true,
        origin: 'remote',
        filenames: getAllFiles(matchingComponent),
      });
    });

  return Array.from(elementMap.values());
};
