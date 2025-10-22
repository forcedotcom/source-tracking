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
import { resolve } from 'node:path';
import * as fs from 'graceful-fs';
import { NamedPackageDir, Logger } from '@salesforce/core';
import {
  ComponentSet,
  MetadataResolver,
  VirtualTreeContainer,
  DestructiveChangesType,
  RegistryAccess,
} from '@salesforce/source-deploy-retrieve';
import { isDefined } from './guards';
import { supportsPartialDelete, pathIsInFolder } from './functions';

type GroupedFileInput = {
  packageDirs: NamedPackageDir[];
  nonDeletes: string[];
  deletes: string[];
};
type GroupedFile = {
  path: string;
  nonDeletes: string[];
  deletes: string[];
};

export const getGroupedFiles = (input: GroupedFileInput, byPackageDir = false): GroupedFile[] =>
  (byPackageDir ? getSequential(input) : getNonSequential(input)).filter(
    (group) => group.deletes.length || group.nonDeletes.length
  );

const getSequential = ({ packageDirs, nonDeletes, deletes }: GroupedFileInput): GroupedFile[] => {
  const nonDeletesByPkgDir = groupByPkgDir(nonDeletes, packageDirs);
  const deletesByPkgDir = groupByPkgDir(deletes, packageDirs);
  return packageDirs.map((pkgDir) => {
    const { name } = pkgDir;
    return {
      path: name,
      nonDeletes: nonDeletesByPkgDir.get(name) ?? [],
      deletes: deletesByPkgDir.get(name) ?? [],
    };
  });
};

const groupByPkgDir = (filePaths: string[], pkgDirs: NamedPackageDir[]): Map<string, string[]> => {
  const groups = new Map<string, string[]>();
  pkgDirs.forEach((pkgDir) => {
    groups.set(pkgDir.name, []);
  });

  filePaths.forEach((filePath) => {
    pkgDirs.forEach((pkgDir) => {
      const { name } = pkgDir;
      if (pathIsInFolder(name)(filePath)) {
        groups.get(name)?.push(filePath);
        return;
      }
    });
  });

  return groups;
};

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
  registry,
}: {
  groupings: GroupedFile[];
  sourceApiVersion?: string;
  registry: RegistryAccess;
}): ComponentSet[] => {
  const logger = Logger.childFromRoot('localComponentSetArray');

  // optimistic resolution...some files may not be possible to resolve
  const resolverForNonDeletes = new MetadataResolver(registry);

  return groupings
    .map((grouping) => {
      logger.debug(
        `building componentSet for ${grouping.path} (deletes: ${grouping.deletes.length} nonDeletes: ${grouping.nonDeletes.length})`
      );

      const componentSet = new ComponentSet(undefined, registry);
      if (sourceApiVersion) {
        componentSet.sourceApiVersion = sourceApiVersion;
      }

      // we need virtual components for the deletes.
      // TODO: could we use the same for the non-deletes?
      const resolverForDeletes = new MetadataResolver(registry, VirtualTreeContainer.fromFilePaths(grouping.deletes));

      grouping.deletes
        .flatMap((filename) => resolverForDeletes.getComponentsFromPath(filename))
        .filter(isDefined)
        .map((component) => {
          // if the component supports partial delete AND there are files that are not deleted,
          // set the component for deploy, not for delete.
          if (supportsPartialDelete(component) && component.content && fs.existsSync(component.content)) {
            // all bundle types have a directory name
            try {
              resolverForNonDeletes
                .getComponentsFromPath(resolve(component.content))
                .filter(isDefined)
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
        .filter(isDefined)
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
