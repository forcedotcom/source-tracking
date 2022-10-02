/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'fs';
import { resolve } from 'path';
import { NamedPackageDir, Logger } from '@salesforce/core';
import {
  ComponentSet,
  MetadataResolver,
  VirtualTreeContainer,
  DestructiveChangesType,
} from '@salesforce/source-deploy-retrieve';
import { sourceComponentGuard } from './guards';
import { isBundle, pathIsInFolder } from './functions';

interface GroupedFileInput {
  packageDirs: NamedPackageDir[];
  nonDeletes: string[];
  deletes: string[];
}
interface GroupedFile {
  path: string;
  nonDeletes: string[];
  deletes: string[];
}

export const getGroupedFiles = (input: GroupedFileInput, byPackageDir = false): GroupedFile[] => (byPackageDir ? getSequential(input) : getNonSequential(input)).filter(
    (group) => group.deletes.length || group.nonDeletes.length
  );

const getSequential = ({ packageDirs, nonDeletes, deletes }: GroupedFileInput): GroupedFile[] =>
  packageDirs.map((pkgDir) => ({
    path: pkgDir.name,
    nonDeletes: nonDeletes.filter((f) => pathIsInFolder(f, pkgDir.name)),
    deletes: deletes.filter((f) => pathIsInFolder(f, pkgDir.name)),
  }));

const getNonSequential = ({
  packageDirs,
  nonDeletes: nonDeletes,
  deletes: deletes,
}: GroupedFileInput): GroupedFile[] => [
  {
    nonDeletes,
    deletes,
    path: packageDirs.map((dir) => dir.name).join(';'),
  },
];

export const getComponentSets = (groupings: GroupedFile[], sourceApiVersion?: string): ComponentSet[] => {
  const logger = Logger.childFromRoot('localComponentSetArray');

  // optimistic resolution...some files may not be possible to resolve
  const resolverForNonDeletes = new MetadataResolver();

  return groupings
    .map((grouping) => {
      logger.debug(
        `building componentSet for ${grouping.path} (deletes: ${grouping.deletes.length} nonDeletes: ${grouping.nonDeletes.length})`
      );

      const componentSet = new ComponentSet();
      if (sourceApiVersion) {
        componentSet.sourceApiVersion = sourceApiVersion;
      }

      // we need virtual components for the deletes.
      // TODO: could we use the same for the non-deletes?
      const resolverForDeletes = new MetadataResolver(undefined, VirtualTreeContainer.fromFilePaths(grouping.deletes));

      grouping.deletes
        .flatMap((filename) => resolverForDeletes.getComponentsFromPath(filename))
        .filter(sourceComponentGuard)
        .map((component) => {
          // if the component is a file in a bundle type AND there are files from the bundle that are not deleted, set the bundle for deploy, not for delete
          if (isBundle(component) && component.content && fs.existsSync(component.content)) {
            // all bundle types have a directory name
            try {
              resolverForNonDeletes
                .getComponentsFromPath(resolve(component.content))
                .filter(sourceComponentGuard)
                .map((nonDeletedComponent) => componentSet.add(nonDeletedComponent));
            } catch (e) {
              logger.warn(
                `unable to find component at ${component.content}.  That's ok if it was supposed to be deleted`
              );
            }
          } else {
            componentSet.add(component, DestructiveChangesType.POST);
          }
        });

      grouping.nonDeletes
        .flatMap((filename) => {
          try {
            return resolverForNonDeletes.getComponentsFromPath(resolve(filename));
          } catch (e) {
            logger.warn(`unable to resolve ${filename}`);
            return undefined;
          }
        })
        .filter(sourceComponentGuard)
        .map((component) => componentSet.add(component));
      // there may have been ignored files, but componentSet.add doesn't automatically track them.
      // We'll manually set the ignored paths from what the resolver has been tracking
      componentSet.forceIgnoredPaths = new Set(
        [...(componentSet.forceIgnoredPaths ?? [])].concat(Array.from(resolverForNonDeletes.forceIgnoredPaths))
      );
      return componentSet;
    })
    .filter((componentSet) => componentSet.size > 0 || componentSet.forceIgnoredPaths?.size);
};
