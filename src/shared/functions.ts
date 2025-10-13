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

import { sep, normalize, isAbsolute, relative } from 'node:path';
import fs from 'node:fs';
import { isString } from '@salesforce/ts-types';
import {
  FileResponseSuccess,
  ForceIgnore,
  MetadataComponent,
  MetadataMember,
  RegistryAccess,
  SourceComponent,
} from '@salesforce/source-deploy-retrieve';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { ensureArray } from '@salesforce/kit';
import { RemoteChangeElement, ChangeResult, ChangeResultWithNameAndType, RemoteSyncInput } from './types.js';
import { ensureNameAndType } from './remoteChangeIgnoring.js';

const keySplit = '###';
const legacyKeySplit = '__';
export const getMetadataKey = (metadataType: string, metadataName: string): string =>
  `${metadataType}${keySplit}${metadataName}`;
export const getLegacyMetadataKey = (metadataType: string, metadataName: string): string =>
  `${metadataType}${legacyKeySplit}${metadataName}`;

export const getMetadataTypeFromKey = (key: string): string => decodeURIComponent(key.split(keySplit)[0]);
export const getMetadataNameFromKey = (key: string): string => decodeURIComponent(key.split(keySplit)[1]);
export const getMetadataTypeFromLegacyKey = (key: string): string => key.split(legacyKeySplit)[0];
export const getMetadataNameFromLegacyKey = (key: string): string =>
  decodeURIComponent(key.split(legacyKeySplit).slice(1).join(legacyKeySplit));

export const getKeyFromObject = (element: RemoteChangeElement | ChangeResult): string => {
  if (element.type && element.name) {
    return getMetadataKey(element.type, element.name);
  }
  throw new Error(`unable to complete key from ${JSON.stringify(element)}`);
};

export const supportsPartialDelete = (cmp: SourceComponent): boolean => !!cmp.type.supportsPartialDelete;

export const excludeLwcLocalOnlyTest = (filePath: string): boolean =>
  !(filePath.includes('__utam__') || filePath.includes('__tests__'));

/**
 * Verify that a filepath starts exactly with a complete parent path
 * ex: '/foo/bar-extra/baz'.startsWith('foo/bar') would be true, but this function understands that they are not in the same folder
 */
export const pathIsInFolder =
  (folder: string) =>
  (filePath: string): boolean => {
    if (folder === filePath) {
      return true;
    }

    // use sep to ensure a folder like foo will not match a filePath like foo-bar
    // comparing foo/ to foo-bar/ ensure this.
    const normalizedFolderPath = normalize(`${folder}${sep}`);
    const normalizedFilePath = normalize(`${filePath}${sep}`);
    if (normalizedFilePath.startsWith(normalizedFolderPath)) {
      return true;
    }

    const filePathParts = normalizedFilePath.split(sep).filter(nonEmptyStringFilter);
    return normalizedFolderPath
      .split(sep)
      .filter(nonEmptyStringFilter)
      .every((part, index) => part === filePathParts[index]);
  };

/** just like pathIsInFolder but with the parameter order reversed for iterating a single file against an array of folders */
export const folderContainsPath =
  (filePath: string) =>
  (folder: string): boolean =>
    pathIsInFolder(folder)(filePath);

const nonEmptyStringFilter = (value: string): boolean => isString(value) && value.length > 0;

// adapted for TS from https://github.com/30-seconds/30-seconds-of-code/blob/master/snippets/chunk.md
export const chunkArray = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));

export const ensureRelative =
  (projectPath: string) =>
  (filePath: string): string =>
    isAbsolute(filePath) ? relative(projectPath, filePath) : filePath;

export type ParsedCustomLabels = {
  CustomLabels: { labels: Array<{ fullName: string }> };
};

/**
 * A method to help delete custom labels from a file, or the entire file if there are no more labels
 *
 * @param filename - a path to a custom labels file
 * @param customLabels - an array of SourceComponents representing the custom labels to delete
 * @returns -json equivalent of the custom labels file's contents OR undefined if the file was deleted/not written
 */
export const deleteCustomLabels = async (
  filename: string,
  customLabels: SourceComponent[]
): Promise<ParsedCustomLabels | undefined> => {
  const customLabelsToDelete = new Set(
    customLabels.filter(sourceComponentIsCustomLabel).map((change) => change.fullName)
  );

  // if we don't have custom labels, we don't need to do anything
  if (!customLabelsToDelete.size) {
    return undefined;
  }
  // for custom labels, we need to remove the individual label from the xml file
  // so we'll parse the xml
  const parser = new XMLParser({
    ignoreDeclaration: false,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const cls = parser.parse(fs.readFileSync(filename, 'utf8')) as ParsedCustomLabels;

  // delete the labels from the json based on their fullName's
  cls.CustomLabels.labels = ensureArray(cls.CustomLabels.labels).filter(
    (label) => !customLabelsToDelete.has(label.fullName)
  );

  if (cls.CustomLabels.labels.length === 0) {
    // we've deleted everything, so let's delete the file
    await fs.promises.unlink(filename);
    return undefined;
  } else {
    // we need to write the file json back to xml back to the fs
    const builder = new XMLBuilder({
      attributeNamePrefix: '@_',
      ignoreAttributes: false,
      format: true,
      indentBy: '    ',
    });
    // and then write that json back to xml and back to the fs
    const xml = builder.build(cls) as string;
    await fs.promises.writeFile(filename, xml);
    return cls;
  }
};

/** returns true if forceIgnore denies a path OR if there is no forceIgnore provided */
export const forceIgnoreDenies =
  (forceIgnore?: ForceIgnore) =>
  (filePath: string): boolean =>
    forceIgnore?.denies(filePath) ?? false;

export const sourceComponentIsCustomLabel = (input: SourceComponent): boolean => input.type.name === 'CustomLabel';

export const sourceComponentHasFullNameAndType = (input: SourceComponent): boolean =>
  typeof input.fullName === 'string' && typeof input.type.name === 'string';

export const getAllFiles = (sc: SourceComponent): string[] => [sc.xml, ...sc.walkContent()].filter(isString);

export const remoteChangeToMetadataMember = (cr: ChangeResult): MetadataMember => {
  const checked = ensureNameAndType(cr);

  return {
    fullName: checked.name,
    type: checked.type,
  };
};

// weird, right?  This is for oclif.table which allows types but not interfaces.  In this case, they are equivalent
export const FileResponseSuccessToRemoteSyncInput = (fr: FileResponseSuccess): RemoteSyncInput => fr;

export const changeResultToMetadataComponent =
  (registry: RegistryAccess = new RegistryAccess()) =>
  (cr: ChangeResultWithNameAndType): MetadataComponent => ({
    fullName: cr.name,
    type: registry.getTypeByName(cr.type),
  });

// TODO: use set.union when node 22 is everywhere
export const uniqueArrayConcat = <T>(arr1: T[] | Set<T>, arr2: T[] | Set<T>): T[] =>
  Array.from(new Set([...arr1, ...arr2]));
