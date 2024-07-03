/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import path from 'node:path';
import { EOL } from 'node:os';
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
import { Performance } from '@oclif/core/performance';
import { isDefined } from '../guards';
import { isDeleted, isAdded, ensureWindows, toFilenames } from './functions';
import { AddAndDeleteMaps, FilenameBasenameHash, StatusRow, StringMap } from './types';

const JOIN_CHAR = '#__#'; // the __ makes it unlikely to be used in metadata names
type AddAndDeleteFileInfos = { addedInfo: FilenameBasenameHash[]; deletedInfo: FilenameBasenameHash[] };
type AddedAndDeletedFilenames = { added: Set<string>; deleted: Set<string> };
type StringMapsForMatches = {
  /** these matches filename=>basename, metadata type/name, and git object hash */
  fullMatches: StringMap;
  /** these did not match the hash.  They *probably* are matches where the "add" is also modified */
  deleteOnly: StringMap;
};

/** composed functions to simplified use by the shadowRepo class */
export const filenameMatchesToMap =
  (isWindows: boolean) =>
  (registry: RegistryAccess) =>
  (projectPath: string) =>
  (gitDir: string) =>
  async ({ added, deleted }: AddedAndDeletedFilenames): Promise<StringMapsForMatches> =>
    excludeNonMatchingTypes(isWindows)(registry)(
      compareHashes(
        await buildMaps(registry)(
          await toFileInfo({
            projectPath,
            gitDir,
            added,
            deleted,
          })
        )
      )
    );

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
const buildMaps =
  (registry: RegistryAccess) =>
  async ({ addedInfo, deletedInfo }: AddAndDeleteFileInfos): Promise<AddAndDeleteMaps> => {
    const [addedMap, addedIgnoredMap] = buildMap(registry)(addedInfo);
    const [deletedMap, deletedIgnoredMap] = buildMap(registry)(deletedInfo);

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
          // these are an exact basename and hash match
          deletedMap.delete(addedKey);
          addedMap.delete(addedKey);
          return [addedValue, deletedValue] as const;
        }
      })
      .filter(isDefined)
  );

  if (addedMap.size && deletedMap.size) {
    // the remaining deletes didn't match the basename+hash of an add, and vice versa.
    // They *might* match the basename of an add, in which case we *could* have the "move, then edit" case.
    const addedBasenameMap = new Map([...addedMap.entries()].map(hashEntryToBasenameEntry));
    const deletedBasenameMap = new Map([...deletedMap.entries()].map(hashEntryToBasenameEntry));
    const deleteOnly = new Map<string, string>(
      Array.from(deletedBasenameMap.entries())
        .filter(([k]) => addedBasenameMap.has(k))
        .map(([k, v]) => [addedBasenameMap.get(k) as string, v])
    );
    return { fullMatches: matches, deleteOnly };
  }
  return { fullMatches: matches, deleteOnly: new Map<string, string>() };
};

/** given a StringMap, resolve the metadata types and return things that having matching type/parent  */
const excludeNonMatchingTypes =
  (isWindows: boolean) =>
  (registry: RegistryAccess) =>
  ({ fullMatches: matches, deleteOnly }: StringMapsForMatches): StringMapsForMatches => {
    if (!matches.size && !deleteOnly.size) return { fullMatches: matches, deleteOnly };
    const [resolvedAdded, resolvedDeleted] = [
      [...matches.keys(), ...deleteOnly.keys()], // the keys/values are only used for the resolver, so we use 1 for both add and delete
      [...matches.values(), ...deleteOnly.values()],
    ]
      .map((filenames) => (isWindows ? filenames.map(ensureWindows) : filenames))
      .map(getResolverForFilenames(registry))
      .map(resolveType);

    return {
      fullMatches: new Map([...matches.entries()].filter(typeFilter(isWindows)(resolvedAdded, resolvedDeleted))),
      deleteOnly: new Map([...deleteOnly.entries()].filter(typeFilter(isWindows)(resolvedAdded, resolvedDeleted))),
    };
  };

const typeFilter =
  (isWindows: boolean) =>
  (resolveAdd: ReturnType<typeof resolveType>, resolveDelete: ReturnType<typeof resolveType>) =>
  ([added, deleted]: [string, string]): boolean => {
    const [resolvedAdded] = resolveAdd(isWindows ? [ensureWindows(added)] : [added]);
    const [resolvedDeleted] = resolveDelete(isWindows ? [ensureWindows(deleted)] : [deleted]);
    return (
      resolvedAdded?.type.name === resolvedDeleted?.type.name &&
      resolvedAdded?.parent?.name === resolvedDeleted?.parent?.name &&
      resolvedAdded?.parent?.type.name === resolvedDeleted?.parent?.type.name
    );
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
  const getInfoMarker = Performance.mark('@salesforce/source-tracking', 'localShadowRepo.detectMovedFiles#toFileInfo', {
    addedFiles: added.size,
    deletedFiles: deleted.size,
  });

  const headRef = await git.resolveRef({ fs, dir: projectPath, gitdir: gitDir, ref: 'HEAD' });
  const [addedInfo, deletedInfo] = await Promise.all([
    await Promise.all(Array.from(added).map(getHashForAddedFile(projectPath))),
    await Promise.all(Array.from(deleted).map(getHashFromActualFileContents(gitDir)(projectPath)(headRef))),
  ]);

  getInfoMarker?.stop();

  return { addedInfo, deletedInfo };
};

/** returns a map of <hash+basename, filepath>.  If two items result in the same hash+basename, return that in the ignore bucket */
const buildMap =
  (registry: RegistryAccess) =>
  (info: FilenameBasenameHash[]): StringMap[] => {
    const map: StringMap = new Map();
    const ignore: StringMap = new Map();
    const ignored: FilenameBasenameHash[] = []; // a raw array so that we don't lose uniqueness when the key matches like a map would

    info.map((i) => {
      const key = toKey(i);
      // If we find a duplicate key, we need to remove it and ignore it in the future.
      // Finding duplicate hash#basename means that we cannot accurately determine where it was moved to or from
      if (map.has(key) || ignore.has(key)) {
        map.delete(key);
        ignore.set(key, i.filename);
        ignored.push(i);
      } else {
        map.set(key, i.filename);
      }
    });

    if (!ignore.size) return [map, ignore];

    // we may be able to differentiate ignored child types by their parent instead of ignoring them.  We'll add the type and parent name to the key
    // ex: All.ListView-meta.xml that have the same name and hash
    const resolver = getResolverForFilenames(registry)(ignored.map((i) => i.filename));
    ignored
      .map((i) => ({ filename: i.filename, simpleKey: toKey(i), cmp: resolveType(resolver)([i.filename])[0] }))
      .filter(({ cmp }) => cmp.type.name && cmp.parent?.fullName)
      .map(({ cmp, filename, simpleKey: key }) => {
        map.set(`${key}${JOIN_CHAR}${cmp.type.name}${JOIN_CHAR}${cmp.parent?.fullName}`, filename);
        ignore.delete(key);
      });

    return [map, ignore];
  };

const getHashForAddedFile =
  (projectPath: string) =>
  async (filepath: string): Promise<FilenameBasenameHash> => ({
    filename: filepath,
    basename: path.basename(filepath),
    hash: (await git.hashBlob({ object: await fs.promises.readFile(path.join(projectPath, filepath)) })).oid,
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
  async (filepath: string): Promise<FilenameBasenameHash> => ({
    filename: filepath,
    basename: path.basename(filepath),
    hash: (await git.readBlob({ fs, dir: projectPath, gitdir, filepath, oid })).oid,
  });

const toKey = (input: FilenameBasenameHash): string => `${input.hash}${JOIN_CHAR}${input.basename}`;

const hashEntryToBasenameEntry = ([k, v]: [string, string]): [string, string] => [hashToBasename(k), v];
const hashToBasename = (hash: string): string => hash.split(JOIN_CHAR)[1];

const getResolverForFilenames =
  (registry: RegistryAccess) =>
  (filenames: string[]): MetadataResolver =>
    new MetadataResolver(registry, VirtualTreeContainer.fromFilePaths(filenames));
