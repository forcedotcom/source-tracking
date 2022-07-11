/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Logger } from '@salesforce/core';
import { isString } from '@salesforce/ts-types';
import { MetadataResolver, VirtualTreeContainer, ForceIgnore } from '@salesforce/source-deploy-retrieve';
import { ChangeResult } from './types';
import { sourceComponentGuard } from './guards';
import { ensureRelative, isLwcLocalOnlyTest } from './functions';
const logger = Logger.childFromRoot('SourceTracking.PopulateTypesAndNames');

/**
 * uses SDR to translate remote metadata records into local file paths (which only typically have the filename).
 *
 * @input elements: ChangeResult[]
 * @input projectPath
 * @input forceIgnore: ForceIgnore.  If provided, result will indicate whether the file is ignored
 * @input excludeUnresolvable: boolean Filter out components where you can't get the name and type (that is, it's probably not a valid source component)
 * @input resolveDeleted: constructs a virtualTree instead of the actual filesystem--useful when the files no longer exist
 */
export const populateTypesAndNames = ({
  elements,
  projectPath,
  forceIgnore,
  excludeUnresolvable = false,
  resolveDeleted = false,
}: {
  elements: ChangeResult[];
  projectPath: string;
  forceIgnore?: ForceIgnore;
  excludeUnresolvable?: boolean;
  resolveDeleted?: boolean;
}): ChangeResult[] => {
  if (elements.length === 0) {
    return [];
  }

  logger.debug(`populateTypesAndNames for ${elements.length} change elements`);
  const filenames = elements.flatMap((element) => element.filenames).filter(isString);

  // component set generated from the filenames on all local changes
  const resolver = new MetadataResolver(
    undefined,
    resolveDeleted ? VirtualTreeContainer.fromFilePaths(filenames) : undefined,
    !!forceIgnore
  );
  const sourceComponents = filenames
    .flatMap((filename) => {
      try {
        return resolver.getComponentsFromPath(filename);
      } catch (e) {
        logger.warn(`unable to resolve ${filename}`);
        return undefined;
      }
    })
    .filter(sourceComponentGuard);

  logger.debug(` matching SourceComponents have ${sourceComponents.length} items from local`);

  // make it simpler to find things later
  const elementMap = new Map<string, ChangeResult>();
  elements.map((element) => {
    element.filenames?.map((filename) => {
      elementMap.set(ensureRelative(filename, projectPath), element);
    });
  });

  // iterates the local components and sets their filenames
  sourceComponents.map((matchingComponent) => {
    if (matchingComponent?.fullName && matchingComponent?.type.name) {
      const filenamesFromMatchingComponent = [matchingComponent.xml, ...matchingComponent.walkContent()];
      const ignored = filenamesFromMatchingComponent
        .filter(isString)
        .filter((f) => !isLwcLocalOnlyTest(f))
        .some((f) => forceIgnore?.denies(f));
      filenamesFromMatchingComponent.map((filename) => {
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
    }
  });
  return excludeUnresolvable
    ? Array.from(new Set(elementMap.values())).filter((changeResult) => changeResult.name && changeResult.type)
    : Array.from(new Set(elementMap.values()));
};
