/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { resolve } from 'node:path';
import { ComponentSet, ForceIgnore, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ConflictResponse, ChangeResult, SourceConflictError } from './types';
import { getMetadataKey } from './functions';
import { populateTypesAndNames } from './populateTypesAndNames';
import { isChangeResultWithNameAndType } from './guards';

export const throwIfConflicts = (conflicts: ConflictResponse[]): void => {
  if (conflicts.length > 0) {
    throw new SourceConflictError(`${conflicts.length} conflicts detected`, conflicts);
  }
};

/**
 *
 * @param cs ComponentSet to compare
 * @param conflicts ChangeResult[] representing conflicts from SourceTracking.getConflicts
 * @returns ConflictResponse[] de-duped and formatted for json or table display
 */
export const findConflictsInComponentSet = (cs: ComponentSet, conflicts: ChangeResult[]): ConflictResponse[] => {
  // map do dedupe by name-type-filename
  const conflictMap = new Map<string, ConflictResponse>();
  conflicts
    .filter(isChangeResultWithNameAndType)
    .filter((cr) => cs.has({ fullName: cr.name, type: cr.type }))
    .forEach((cr) => {
      cr.filenames?.forEach((f) => {
        conflictMap.set(`${cr.name}#${cr.type}#${f}`, {
          state: 'Conflict',
          fullName: cr.name,
          type: cr.type,
          filePath: resolve(f),
        });
      });
    });
  const reformattedConflicts = Array.from(conflictMap.values());
  return reformattedConflicts;
};

export const getDedupedConflictsFromChanges = ({
  localChanges = [],
  remoteChanges = [],
  projectPath,
  forceIgnore,
  registry,
}: {
  localChanges: ChangeResult[];
  remoteChanges: ChangeResult[];
  projectPath: string;
  forceIgnore: ForceIgnore;
  registry: RegistryAccess;
}): ChangeResult[] => {
  const metadataKeyIndex = new Map(
    remoteChanges
      .filter(isChangeResultWithNameAndType)
      .map((change) => [getMetadataKey(change.name, change.type), change])
  );
  const fileNameIndex = new Map(
    remoteChanges.flatMap((change) => (change.filenames ?? []).map((filename) => [filename, change]))
  );

  const conflicts = new Set<ChangeResult>();

  populateTypesAndNames({ excludeUnresolvable: true, projectPath, forceIgnore, registry })(localChanges)
    .filter(isChangeResultWithNameAndType)
    .map((change) => {
      const metadataKey = getMetadataKey(change.name, change.type);
      // option 1: name and type match
      if (metadataKeyIndex.has(metadataKey)) {
        conflicts.add({ ...(metadataKeyIndex.get(metadataKey) as ChangeResult) });
      } else {
        // option 2: some of the filenames match
        change.filenames?.map((filename) => {
          if (fileNameIndex.has(filename)) {
            conflicts.add({ ...(fileNameIndex.get(filename) as ChangeResult) });
          }
        });
      }
    });
  // deeply de-dupe
  return Array.from(conflicts);
};
