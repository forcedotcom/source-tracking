/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import path from 'node:path';
import { Logger, Lifecycle } from '@salesforce/core';
import {
  MetadataResolver,
  SourceComponent,
  RegistryAccess,
  VirtualTreeContainer,
} from '@salesforce/source-deploy-retrieve';
// @ts-expect-error isogit has both ESM and CJS exports but node16 module/resolution identifies it as ESM
import git from 'isomorphic-git';
import * as fs from 'graceful-fs';
import { sourceComponentGuard } from '../guards';
import { isDeleted, isAdded, ensureWindows, toFilenames } from './functions';
import { AddAndDeleteMaps, FileInfo, StatusRow, StringMap } from './types';

/** compare delete and adds from git.status, matching basenames of the files.  returns early when there's nothing to match */
export const getMatches = (
  status: StatusRow[]
): { deletedFilenamesWithMatches: Set<string>; addedFilenamesWithMatches: Set<string> } | undefined => {
  // We check for moved files in incremental steps and exit as early as we can to avoid any performance degradation
  // Deleted files will be more rare than added files, so we'll check them first and exit early if there are none
  const deletedFiles = status.filter(isDeleted);
  if (!deletedFiles.length) return;

  const addedFiles = status.filter(isAdded);
  if (!addedFiles.length) return;

  // Both arrays have contents, look for matching basenames
  const addedFilenames = toFilenames(addedFiles);
  const deletedFilenames = toFilenames(deletedFiles);

  // Build Sets of basenames for added and deleted files for quick lookups
  const addedBasenames = new Set(addedFilenames.map((filename) => path.basename(filename)));
  const deletedBasenames = new Set(deletedFilenames.map((filename) => path.basename(filename)));

  // Again, we filter over the deleted files first and exit early if there are no filename matches
  const deletedFilenamesWithMatches = new Set(deletedFilenames.filter((f) => addedBasenames.has(path.basename(f))));
  if (!deletedFilenamesWithMatches.size) return;

  const addedFilenamesWithMatches = new Set(addedFilenames.filter((f) => deletedBasenames.has(path.basename(f))));
  if (!addedFilenamesWithMatches.size) return;

  return { addedFilenamesWithMatches, deletedFilenamesWithMatches };
};

export const getHash =
  (gitdir: string) =>
  (projectPath: string) =>
  (oid: string) =>
  async (filepath: string): Promise<FileInfo> => ({
    filename: filepath,
    basename: path.basename(filepath),
    hash: (await git.readBlob({ fs, dir: projectPath, gitdir, filepath, oid })).oid,
  });

/** build maps of the add/deletes with filenames, returning the matches  Logs if non-matches */
export const buildMaps = async (addedInfo: FileInfo[], deletedInfo: FileInfo[]): Promise<AddAndDeleteMaps> => {
  const [addedMap, addedIgnoredMap] = buildMap(addedInfo);
  const [deletedMap, deletedIgnoredMap] = buildMap(deletedInfo);

  // If we detected any files that have the same basename and hash, emit a warning and send telemetry
  // These files will still show up as expected in the `sf project deploy preview` output
  // We could add more logic to determine and display filepaths that we ignored...
  // but this is likely rare enough to not warrant the added complexity
  // Telemetry will help us determine how often this occurs
  if (addedIgnoredMap.size || deletedIgnoredMap.size) {
    const message = 'Files were found that have the same basename and hash. Skipping the commit of these files';
    const logger = Logger.childFromRoot('ShadowRepo.compareHashes');
    logger.warn(message);
    const lifecycle = Lifecycle.getInstance();
    await Promise.all([
      lifecycle.emitWarning(message),
      lifecycle.emitTelemetry({ eventName: 'moveFileHashBasenameCollisionsDetected' }),
    ]);
  }
  return { addedMap, deletedMap };
};

/** builds a map of the values from both maps */
export const compareHashes = ({ addedMap, deletedMap }: AddAndDeleteMaps): StringMap => {
  const matches: StringMap = new Map();

  for (const [addedKey, addedValue] of addedMap) {
    const deletedValue = deletedMap.get(addedKey);
    if (deletedValue) {
      matches.set(addedValue, deletedValue);
    }
  }

  return matches;
};

export const buildMap = (info: FileInfo[]): StringMap[] => {
  const map: StringMap = new Map();
  const ignore: StringMap = new Map();
  info.map((i) => {
    const key = `${i.hash}#${i.basename}`;
    // If we find a duplicate key, we need to remove it and ignore it in the future.
    // Finding duplicate hash#basename means that we cannot accurately determine where it was moved to or from
    if (map.has(key) || ignore.has(key)) {
      map.delete(key);
      ignore.set(key, i.filename);
    } else {
      map.set(key, i.filename);
    }
  });
  return [map, ignore];
};

export const removeNonMatches = (matches: StringMap, registry: RegistryAccess, isWindows: boolean): StringMap => {
  const addedFiles = isWindows ? [...matches.keys()].map(ensureWindows) : [...matches.keys()];
  const deletedFiles = isWindows ? [...matches.values()].map(ensureWindows) : [...matches.values()];
  const resolverAdded = new MetadataResolver(registry, VirtualTreeContainer.fromFilePaths(addedFiles));
  const resolverDeleted = new MetadataResolver(registry, VirtualTreeContainer.fromFilePaths(deletedFiles));

  return new Map(
    [...matches.entries()].filter(([addedFile, deletedFile]) => {
      // we're only ever using the first element of the arrays
      const [resolvedAdded] = resolveType(resolverAdded, isWindows ? [ensureWindows(addedFile)] : [addedFile]);
      const [resolvedDeleted] = resolveType(resolverDeleted, isWindows ? [ensureWindows(deletedFile)] : [deletedFile]);
      return (
        // they could match, or could both be undefined (because unresolved by SDR)
        resolvedAdded?.type.name === resolvedDeleted?.type.name &&
        // parent names match, if resolved and there are parents
        resolvedAdded?.parent?.name === resolvedDeleted?.parent?.name &&
        // parent types match, if resolved and there are parents
        resolvedAdded?.parent?.type.name === resolvedDeleted?.parent?.type.name
      );
    })
  );
};

const resolveType = (resolver: MetadataResolver, filenames: string[]): SourceComponent[] =>
  filenames
    .flatMap((filename) => {
      try {
        return resolver.getComponentsFromPath(filename);
      } catch (e) {
        const logger = Logger.childFromRoot('ShadowRepo.compareTypes');
        logger.warn(`unable to resolve ${filename}`);
        return undefined;
      }
    })
    .filter(sourceComponentGuard);
