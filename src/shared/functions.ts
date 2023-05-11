/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { sep, normalize, isAbsolute, relative } from 'path';
import * as fs from 'fs';
import { isString } from '@salesforce/ts-types';
import { SourceComponent } from '@salesforce/source-deploy-retrieve';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { ensureArray } from '@salesforce/kit';
import { RemoteChangeElement, ChangeResult } from './types';

export const getMetadataKey = (metadataType: string, metadataName: string): string =>
  `${metadataType}__${metadataName}`;

export const getKeyFromObject = (element: RemoteChangeElement | ChangeResult): string => {
  if (element.type && element.name) {
    return getMetadataKey(element.type, element.name);
  }
  throw new Error(`unable to complete key from ${JSON.stringify(element)}`);
};

export const supportsPartialDelete = (cmp: SourceComponent): boolean => !!cmp.type.supportsPartialDelete;

export const isLwcLocalOnlyTest = (filePath: string): boolean =>
  filePath.includes('__utam__') || filePath.includes('__tests__');

/**
 * Verify that a filepath starts exactly with a complete parent path
 * ex: '/foo/bar-extra/baz'.startsWith('foo/bar') would be true, but this function understands that they are not in the same folder
 */
export const pathIsInFolder = (filePath: string, folder: string): boolean => {
  const biggerStringParts = normalize(filePath).split(sep).filter(nonEmptyStringFilter);
  return normalize(folder)
    .split(sep)
    .filter(nonEmptyStringFilter)
    .every((part, index) => part === biggerStringParts[index]);
};

const nonEmptyStringFilter = (value: string): boolean => isString(value) && value.length > 0;

// adapted for TS from https://github.com/30-seconds/30-seconds-of-code/blob/master/snippets/chunk.md
export const chunkArray = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));

export const ensureRelative = (filePath: string, projectPath: string): string =>
  isAbsolute(filePath) ? relative(projectPath, filePath) : filePath;

/**
 * A method to help delete custom labels from a file, or the entire file if there are no more labels
 *
 * @param filename - a path to a custom labels file
 * @param customLabels - an array of SourceComponents representing the custom labels to delete
 */
export const deleteCustomLabels = (filename: string, customLabels: SourceComponent[]): Promise<void> => {
  const customLabelsToDelete = customLabels
    .filter((label) => label.type.id === 'customlabel')
    .map((change) => change.fullName);

  // if we don't have custom labels, we don't need to do anything
  if (!customLabelsToDelete.length) {
    return Promise.resolve();
  }
  // for custom labels, we need to remove the individual label from the xml file
  // so we'll parse the xml
  const parser = new XMLParser({
    ignoreDeclaration: false,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const cls = parser.parse(fs.readFileSync(filename, 'utf8')) as {
    CustomLabels: { labels: Array<{ fullName: string }> };
  };

  // delete the labels from the json based on their fullName's
  cls.CustomLabels.labels = ensureArray(cls.CustomLabels.labels).filter(
    (label) => !customLabelsToDelete.includes(label.fullName)
  );

  if (cls.CustomLabels.labels.length === 0) {
    // we've deleted everything, so let's delete the file
    return fs.promises.unlink(filename);
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
    return fs.promises.writeFile(filename, xml);
  }
};
