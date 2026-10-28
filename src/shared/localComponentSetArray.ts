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
import fs from 'node:fs';
import { resolve } from 'node:path';
import { NamedPackageDir, Logger } from '@salesforce/core';
import {
  ComponentSet,
  MetadataResolver,
  VirtualTreeContainer,
  DestructiveChangesType,
  RegistryAccess,
} from '@salesforce/source-deploy-retrieve';
import { isDefined } from './guards';
import { supportsPartialDelete, pathIsInFolder, maybeGetTreeContainer } from './functions';

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
}: GroupedFileInput): GroupedFile[] => {
  if (packageDirs.length === 0) return [];
  return [
    {
      nonDeletes,
      deletes,
      path: packageDirs.map((dir) => dir.name).join(';'),
    },
  ];
};

const yieldAfter = async (index: number): Promise<void> => {
  // Keep VS Code's extension host responsive during large metadata resolves.
  if (index > 0 && index % 100 === 0) {
    await new Promise<void>((continueWork) => setImmediate(continueWork));
  }
};

export const getComponentSets = async ({
  groupings,
  sourceApiVersion,
  registry,
  projectPath,
}: {
  groupings: GroupedFile[];
  sourceApiVersion?: string;
  registry: RegistryAccess;
  /** absolute path to the project root */
  projectPath: string;
}): Promise<ComponentSet[]> => {
  const logger = Logger.childFromRoot('localComponentSetArray');

  // optimistic resolution...some files may not be possible to resolve
  const resolverForNonDeletes = new MetadataResolver(registry, maybeGetTreeContainer(projectPath));

  const componentSets: ComponentSet[] = [];
  for (const grouping of groupings) {
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

    for (const [index, filename] of grouping.deletes.entries()) {
      for (const component of resolverForDeletes.getComponentsFromPath(filename).filter(isDefined)) {
        // if the component supports partial delete AND there are files that are not deleted,
        // set the component for deploy, not for delete.
        if (supportsPartialDelete(component) && component.content && fs.existsSync(component.content)) {
          // all bundle types have a directory name
          try {
            for (const nonDeletedComponent of resolverForNonDeletes
              .getComponentsFromPath(resolve(projectPath, component.content))
              .filter(isDefined)) {
              componentSet.add(nonDeletedComponent);
            }
          } catch (e) {
            logger.warn(
              `unable to find component at ${component.content}.  That's ok if it was supposed to be deleted`
            );
          }
        } else {
          componentSet.add(component, DestructiveChangesType.POST);
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await yieldAfter(index);
    }

    for (const [index, filename] of grouping.nonDeletes.entries()) {
      try {
        for (const component of resolverForNonDeletes
          .getComponentsFromPath(resolve(projectPath, filename))
          .filter(isDefined)) {
          componentSet.add(component);
        }
      } catch (e) {
        logger.warn(`unable to resolve ${filename}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await yieldAfter(index);
    }
    // there may have been ignored files, but componentSet.add doesn't automatically track them.
    // We'll manually set the ignored paths from what the resolver has been tracking
    componentSet.forceIgnoredPaths = new Set(
      [...(componentSet.forceIgnoredPaths ?? [])].concat(Array.from(resolverForNonDeletes.forceIgnoredPaths))
    );
    componentSet.projectDirectory = projectPath;
    if (componentSet.size > 0 || componentSet.forceIgnoredPaths?.size) {
      componentSets.push(componentSet);
    }
  }
  return componentSets;
};
