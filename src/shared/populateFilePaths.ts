/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { EOL } from 'node:os';
import { Logger } from '@salesforce/core';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { ChangeResult } from './types';
import { metadataMemberGuard } from './guards';
import { getKeyFromObject, getMetadataKey } from './functions';

/**
 * Will build a component set, crawling your local directory, to get paths for remote changes
 *
 * @param elements ChangeResults that may or may not have filepaths in their filenames parameters
 * @param packageDirPaths Array of paths from PackageDirectories
 * @returns
 */
export const populateFilePaths = (elements: ChangeResult[], packageDirPaths: string[]): ChangeResult[] => {
  if (elements.length === 0) {
    return [];
  }
  const logger = Logger.childFromRoot('SourceTracking.PopulateFilePaths');
  logger.debug('populateFilePaths for change elements', elements);
  // component set generated from an array of MetadataMember from all the remote changes
  // but exclude the ones that aren't in the registry
  const remoteChangesAsMetadataMember = elements
    .map((element) => {
      if (typeof element.type === 'string' && typeof element.name === 'string') {
        return {
          type: element.type,
          fullName: element.name,
        };
      }
    })
    .filter(metadataMemberGuard);

  const remoteChangesAsComponentSet = new ComponentSet(remoteChangesAsMetadataMember);

  logger.debug(` the generated component set has ${remoteChangesAsComponentSet.size.toString()} items`);
  if (remoteChangesAsComponentSet.size < elements.length) {
    // there *could* be something missing
    // some types (ex: LWC) show up as multiple files in the remote changes, but only one in the component set
    // iterate the elements to see which ones didn't make it into the component set
    const missingComponents = elements.filter(
      (element) =>
        !remoteChangesAsComponentSet.has({ type: element?.type as string, fullName: element?.name as string })
    );
    // Throw if anything was actually missing
    if (missingComponents.length > 0) {
      throw new Error(
        `unable to generate complete component set for ${elements
          .map((element) => `${element.name} (${element.type})`)
          .join(EOL)}`
      );
    }
  }

  const matchingLocalSourceComponentsSet = ComponentSet.fromSource({
    fsPaths: packageDirPaths,
    include: remoteChangesAsComponentSet,
  });
  logger.debug(
    ` local source-backed component set has ${matchingLocalSourceComponentsSet.size.toString()} items from remote`
  );

  // make it simpler to find things later
  const elementMap = new Map<string, ChangeResult>(elements.map((e) => [getKeyFromObject(e), e]));

  // iterates the local components and sets their filenames
  for (const matchingComponent of matchingLocalSourceComponentsSet.getSourceComponents().toArray()) {
    if (matchingComponent.fullName && matchingComponent.type.name) {
      logger.debug(
        `${matchingComponent.fullName}|${matchingComponent.type.name} matches ${
          matchingComponent.xml
        } and maybe ${matchingComponent.walkContent().toString()}`
      );
      // Decode the key since local components can have encoded fullNames, but results from querying
      // SourceMembers have fullNames that are not encoded. See:  https://github.com/forcedotcom/cli/issues/1683
      const key = decodeURIComponent(getMetadataKey(matchingComponent.type.name, matchingComponent.fullName));
      elementMap.set(key, {
        ...elementMap.get(key),
        modified: true,
        origin: 'remote',
        filenames: [matchingComponent.xml as string, ...matchingComponent.walkContent()].filter((filename) => filename),
      });
    }
  }

  return Array.from(elementMap.values());
};
