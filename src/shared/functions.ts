/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { sep, normalize, isAbsolute, relative } from 'node:path';
import * as fs from 'node:fs';
import { isString } from '@salesforce/ts-types';
import {
  ForceIgnore,
  MetadataComponent,
  MetadataMember,
  RegistryAccess,
  SourceComponent,
} from '@salesforce/source-deploy-retrieve';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { ensureArray } from '@salesforce/kit';
import { RemoteChangeElement, ChangeResult, ChangeResultWithNameAndType } from './types';
import { ensureNameAndType } from './remoteChangeIgnoring';

export const getMetadataKey = (metadataType: string, metadataName: string): string =>
  `${metadataType}__${metadataName}`;

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
    const biggerStringParts = normalize(filePath).split(sep).filter(nonEmptyStringFilter);
    return normalize(folder)
      .split(sep)
      .filter(nonEmptyStringFilter)
      .every((part, index) => part === biggerStringParts[index]);
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

export const sourceComponentIsCustomLabel = (input: SourceComponent): boolean => input.type.id === 'customlabel';

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

export const changeResultToMetadataComponent =
  (registry: RegistryAccess = new RegistryAccess()) =>
  (cr: ChangeResultWithNameAndType): MetadataComponent => ({
    fullName: cr.name,
    type: registry.getTypeByName(cr.type),
  });
