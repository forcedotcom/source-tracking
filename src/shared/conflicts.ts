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
          filePath: resolve(...[...(cs.projectDirectory ? [cs.projectDirectory, f] : [f])]),
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

  return populateTypesAndNames({ excludeUnresolvable: true, projectPath, forceIgnore, registry })(localChanges)
    .filter(isChangeResultWithNameAndType)
    .flatMap((change) => {
      const metadataKey = getMetadataKey(change.name, change.type);
      return metadataKeyIndex.has(metadataKey)
        ? // option 1: name and type match
          [metadataKeyIndex.get(metadataKey)!]
        : // option 2: some of the filenames match
          (change.filenames ?? [])
            .filter((filename) => fileNameIndex.has(filename))
            .map((filename) => fileNameIndex.get(filename)!);
    });
};
