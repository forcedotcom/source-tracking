/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { resolve } from 'node:path';
import { ComponentSet, ForceIgnore } from '@salesforce/source-deploy-retrieve';
import { ConflictResponse, ChangeResult, SourceConflictError } from './types';
import { getMetadataKey } from './functions';
import { populateTypesAndNames } from './populateTypesAndNames';

export const throwIfConflicts = (conflicts: ConflictResponse[]): void => {
  if (conflicts.length > 0) {
    const conflictError = new SourceConflictError(`${conflicts.length} conflicts detected`, 'SourceConflictError');
    conflictError.setData(conflicts);
    throw conflictError;
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
    .filter((cr) => cr.name && cr.type && cs.has({ fullName: cr.name, type: cr.type }))
    .forEach((cr) => {
      cr.filenames?.forEach((f) => {
        conflictMap.set(`${cr.name}#${cr.type}#${f}`, {
          state: 'Conflict',
          // the following 2 type assertions are valid because of previous filter statement
          // they can be removed once TS is smarter about filtering
          fullName: cr.name as string,
          type: cr.type as string,
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
}: {
  localChanges: ChangeResult[];
  remoteChanges: ChangeResult[];
  projectPath: string;
  forceIgnore: ForceIgnore;
}): ChangeResult[] => {
  // index the remoteChanges by filename
  const fileNameIndex = new Map<string, ChangeResult>();
  const metadataKeyIndex = new Map<string, ChangeResult>();
  remoteChanges.map((change) => {
    if (change.name && change.type) {
      metadataKeyIndex.set(getMetadataKey(change.name, change.type), change);
    }
    change.filenames?.map((filename) => {
      fileNameIndex.set(filename, change);
    });
  });

  const conflicts = new Set<ChangeResult>();

  populateTypesAndNames({ elements: localChanges, excludeUnresolvable: true, projectPath, forceIgnore }).map(
    (change) => {
      const metadataKey = getMetadataKey(change.name as string, change.type as string);
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
    }
  );
  // deeply de-dupe
  return Array.from(conflicts);
};
