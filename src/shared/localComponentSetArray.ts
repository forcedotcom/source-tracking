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

export const getGroupedFiles = (input: GroupedFileInput, byPackageDir = false): GroupedFile[] => {
  return (byPackageDir ? getSequential(input) : getNonSequential(input)).filter(
    (group) => group.deletes.length || group.nonDeletes.length
  );
};

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

export const getComponentSets = ({
  groupings,
  sourceApiVersion,
  includeIgnored = false,
}: {
  groupings: GroupedFile[];
  sourceApiVersion?: string;
  includeIgnored: boolean;
}): ComponentSet[] => {
  const logger = Logger.childFromRoot('localComponentSetArray');

  // TODO: could we use the same for the non-deletes (ie, virtual tree instead of live fs?)
  //  - we'd have to guarantee that none of the SDR resolver stuff needs anything besides the path
  // the nonDelete resolver is used by both deletes and nonDeletes (because bundles)
  const resolverForNonDeletes = new MetadataResolver(undefined, undefined, !includeIgnored);

  // if there are no deletes, we avoid the cost of constructing the resolver
  // we need virtual components if there are deletes.
  // one resolver for all deletes across groupings
  const resolverForDeletes = groupings.some((g) => g.deletes.length)
    ? new MetadataResolver(
        undefined,
        VirtualTreeContainer.fromFilePaths(groupings.flatMap((g) => g.deletes)),
        !includeIgnored
      )
    : undefined;

  return groupings
    .map((grouping) => {
      logger.debug(
        `building componentSet for ${grouping.path} (deletes: ${grouping.deletes.length} nonDeletes: ${grouping.nonDeletes.length})`
      );

      const componentSet = grouping.nonDeletes.length
        ? ComponentSet.fromSource(
            grouping.nonDeletes
              // some files may not be resolvable but might be part of local source.
              // examples: readme.md, gitignores, etc.
              // resolver will throw when it can't figure out the component type
              .filter((filename) => {
                try {
                  resolverForNonDeletes?.getComponentsFromPath(resolve(filename));
                  return true;
                } catch (e) {
                  logger.warn(`unable to resolve ${filename}`);
                  return false;
                }
              })
          )
        : // there could be no nonDeletes if we're only deleting files
          new ComponentSet();

      grouping.deletes
        .flatMap((filename) => resolverForDeletes?.getComponentsFromPath(filename))
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

      if (sourceApiVersion) {
        componentSet.sourceApiVersion = sourceApiVersion;
      }
      return componentSet;
    })
    .filter((componentSet) => componentSet.size > 0);
};
