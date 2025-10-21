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
import path from 'node:path';
import { EOL } from 'node:os';
import { Logger, Lifecycle, fs } from '@salesforce/core';
import {
  MetadataResolver,
  SourceComponent,
  RegistryAccess,
  VirtualTreeContainer,
} from '@salesforce/source-deploy-retrieve';
import git from 'isomorphic-git';
import { isDefined } from '../guards';
import { uniqueArrayConcat } from '../functions';
import { isDeleted, isAdded, toFilenames, IS_WINDOWS, ensurePosix } from './functions';
import { AddAndDeleteMaps, DetectionFileInfo, DetectionFileInfoWithType, StatusRow, StringMap } from './types';

const JOIN_CHAR = '#__#'; // the __ makes it unlikely to be used in metadata names
type AddAndDeleteFileInfos = Readonly<{ addedInfo: DetectionFileInfo[]; deletedInfo: DetectionFileInfo[] }>;
type AddAndDeleteFileInfosWithTypes = {
  addedInfo: DetectionFileInfoWithType[];
  deletedInfo: DetectionFileInfoWithType[];
};
type AddedAndDeletedFilenames = { added: Set<string>; deleted: Set<string> };
type StringMapsForMatches = {
  /** these matches filename=>basename, metadata type/name, and git object hash */
  fullMatches: StringMap;
  /** these did not match the hash.  They *probably* are matches where the "add" is also modified */
  deleteOnly: StringMap;
};

/** composed functions to simplified use by the shadowRepo class */
export const filenameMatchesToMap =
  (registry: RegistryAccess) =>
  (projectPath: string) =>
  (gitDir: string) =>
  async ({ added, deleted }: AddedAndDeletedFilenames): Promise<StringMapsForMatches> => {
    const resolver = new MetadataResolver(
      registry,
      VirtualTreeContainer.fromFilePaths(uniqueArrayConcat(added, deleted))
    );

    return compareHashes(
      await buildMaps(
        addTypes(resolver)(
          await toFileInfo({
            projectPath,
            gitDir,
            added,
            deleted,
          })
        )
      )
    );
  };

/** compare delete and adds from git.status, matching basenames of the files.  returns early when there's nothing to match */
export const getMatches = (status: StatusRow[]): AddedAndDeletedFilenames => {
  // We check for moved files in incremental steps and exit as early as we can to avoid any performance degradation
  // Deleted files will be more rare than added files, so we'll check them first and exit early if there are none
  const emptyResult = { added: new Set<string>(), deleted: new Set<string>() };
  const deletedFiles = status.filter(isDeleted);
  if (!deletedFiles.length) return emptyResult;

  const addedFiles = status.filter(isAdded);
  if (!addedFiles.length) return emptyResult;

  // Both arrays have contents, look for matching basenames
  const addedFilenames = toFilenames(addedFiles);
  const deletedFilenames = toFilenames(deletedFiles);

  // Build Sets of basenames for added and deleted files for quick lookups
  const addedBasenames = new Set(addedFilenames.map((filename) => path.basename(filename)));
  const deletedBasenames = new Set(deletedFilenames.map((filename) => path.basename(filename)));

  // TODO: when node 22 is everywhere, we can use Set.prototype.intersection
  // Again, we filter over the deleted files first and exit early if there are no filename matches
  const deletedFilenamesWithMatches = new Set(deletedFilenames.filter((f) => addedBasenames.has(path.basename(f))));
  if (!deletedFilenamesWithMatches.size) return emptyResult;

  const addedFilenamesWithMatches = new Set(addedFilenames.filter((f) => deletedBasenames.has(path.basename(f))));
  if (!addedFilenamesWithMatches.size) return emptyResult;

  return { added: addedFilenamesWithMatches, deleted: deletedFilenamesWithMatches };
};

export const getLogMessage = (matches: StringMapsForMatches): string =>
  [
    'Files have moved. Committing moved files:',
    ...[...matches.fullMatches.entries()].map(([add, del]) => `- File ${del} was moved to ${add}`),
    ...[...matches.deleteOnly.entries()].map(([add, del]) => `- File ${del} was moved to ${add} and modified`),
  ].join(EOL);

/** build maps of the add/deletes with filenames, returning the matches  Logs if we can't make a match because buildMap puts them in the ignored bucket */
const buildMaps = async ({ addedInfo, deletedInfo }: AddAndDeleteFileInfosWithTypes): Promise<AddAndDeleteMaps> => {
  const [addedMap, addedIgnoredMap] = buildMap(addedInfo);
  const [deletedMap, deletedIgnoredMap] = buildMap(deletedInfo);

  // If we detected any files that have the same basename and hash, emit a warning and send telemetry
  // These files will still show up as expected in the `sf project deploy preview` output
  // We could add more logic to determine and display filepaths that we ignored...
  // but this is likely rare enough to not warrant the added complexity
  // Telemetry will help us determine how often this occurs
  if (addedIgnoredMap.size || deletedIgnoredMap.size) {
    const message =
      'Files were found that have the same basename, hash, metadata type, and parent. Skipping the commit of these files';
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

/**
 * builds a map of the values from both maps
 * side effect: mutates the passed-in maps!
 */
const compareHashes = ({ addedMap, deletedMap }: AddAndDeleteMaps): StringMapsForMatches => {
  const matches = new Map<string, string>(
    [...addedMap.entries()]
      .map(([addedKey, addedValue]) => {
        const deletedValue = deletedMap.get(addedKey);
        if (deletedValue) {
          // these are an exact basename + hash match + parent + type
          deletedMap.delete(addedKey);
          addedMap.delete(addedKey);
          return [addedValue, deletedValue] as const;
        }
      })
      .filter(isDefined)
  );

  if (addedMap.size && deletedMap.size) {
    // the remaining deletes didn't match the basename+hash of an add, and vice versa.
    // They *might* match the basename,type,parent of an add, in which case we *could* have the "move, then edit" case.
    const addedMapNoHash = new Map([...addedMap.entries()].map(removeHashFromEntry));
    const deletedMapNoHash = new Map([...deletedMap.entries()].map(removeHashFromEntry));
    const deleteOnly = new Map<string, string>(
      Array.from(deletedMapNoHash.entries())
        .filter(([k]) => addedMapNoHash.has(k))
        .map(([k, v]) => [addedMapNoHash.get(k) as string, v])
    );
    return { fullMatches: matches, deleteOnly };
  }
  return { fullMatches: matches, deleteOnly: new Map<string, string>() };
};

/** enrich the filenames with basename and oid (hash)  */
const toFileInfo = async ({
  projectPath,
  gitDir,
  added,
  deleted,
}: {
  projectPath: string;
  gitDir: string;
  added: Set<string>;
  deleted: Set<string>;
}): Promise<AddAndDeleteFileInfos> => {
  // Track how long it takes to gather the oid information from the git trees

  const headRef = await git.resolveRef({ fs, dir: projectPath, gitdir: gitDir, ref: 'HEAD' });
  const [addedInfo, deletedInfo] = await Promise.all([
    await Promise.all(Array.from(added).map(getHashForAddedFile(projectPath))),
    await Promise.all(Array.from(deleted).map(getHashFromActualFileContents(gitDir)(projectPath)(headRef))),
  ]);

  return { addedInfo, deletedInfo };
};

/** returns a map of <hash+basename, filepath>.  If two items result in the same hash+basename, return that in the ignore bucket */
const buildMap = (info: DetectionFileInfoWithType[]): StringMap[] => {
  const map: StringMap = new Map();
  const ignore: StringMap = new Map();

  info.map((i) => {
    const key = toKey(i);
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

const getHashForAddedFile =
  (projectPath: string) =>
  async (filepath: string): Promise<DetectionFileInfo> => ({
    filename: filepath,
    basename: path.basename(filepath),
    hash: (
      await git.hashBlob({
        object: await fs.promises.readFile(path.join(projectPath, filepath)),
      })
    ).oid,
  });

const resolveType =
  (resolver: MetadataResolver) =>
  (filenames: string[]): SourceComponent[] =>
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
      .filter(isDefined);

/** where we don't have git objects to use, read the file contents to generate the hash */
const getHashFromActualFileContents =
  (gitdir: string) =>
  (projectPath: string) =>
  (oid: string) =>
  async (filepath: string): Promise<DetectionFileInfo> => ({
    filename: filepath,
    basename: path.basename(filepath),
    hash: (
      await git.readBlob({ fs, dir: projectPath, gitdir, filepath: IS_WINDOWS ? ensurePosix(filepath) : filepath, oid })
    ).oid,
  });

const toKey = (input: DetectionFileInfoWithType): string =>
  [input.hash, input.basename, input.type, input.type, input.parentType ?? '', input.parentFullName ?? ''].join(
    JOIN_CHAR
  );

const removeHashFromEntry = ([k, v]: [string, string]): [string, string] => [removeHashFromKey(k), v];
const removeHashFromKey = (hash: string): string => hash.split(JOIN_CHAR).splice(1).join(JOIN_CHAR);

/** resolve the metadata types (and possibly parent components) */
const addTypes =
  (resolver: MetadataResolver) =>
  (info: AddAndDeleteFileInfos): AddAndDeleteFileInfosWithTypes => {
    // quick passthrough if we don't have adds and deletes
    if (!info.addedInfo.length || !info.deletedInfo.length) return { addedInfo: [], deletedInfo: [] };
    const applied = getTypesForFileInfo(resolveType(resolver));
    return {
      addedInfo: info.addedInfo.flatMap(applied),
      deletedInfo: info.deletedInfo.flatMap(applied),
    };
  };

const getTypesForFileInfo =
  (appliedResolver: (filenames: string[]) => SourceComponent[]) =>
  (fileInfo: DetectionFileInfo): DetectionFileInfoWithType[] =>
    appliedResolver([fileInfo.filename]).map((c) => ({
      ...fileInfo,
      type: c.type.name,
      parentType: c.parent?.type.name ?? '',
      parentFullName: c.parent?.fullName ?? '',
    }));
