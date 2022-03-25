/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { sep, normalize } from 'path';
import { isString } from '@salesforce/ts-types';
import { SourceComponent } from '@salesforce/source-deploy-retrieve';
import { RemoteChangeElement, ChangeResult } from './types';

export const getMetadataKey = (metadataType: string, metadataName: string): string => {
  return `${metadataType}__${metadataName}`;
};

export const getKeyFromObject = (element: RemoteChangeElement | ChangeResult): string => {
  if (element.type && element.name) {
    return getMetadataKey(element.type, element.name);
  }
  throw new Error(`unable to complete key from ${JSON.stringify(element)}`);
};

export const isBundle = (cmp: SourceComponent): boolean => cmp.type.strategies?.adapter === 'bundle';

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

const nonEmptyStringFilter = (value: string): boolean => {
  return isString(value) && value.length > 0;
};

// adapted for TS from https://github.com/30-seconds/30-seconds-of-code/blob/master/snippets/chunk.md
export const chunkArray = <T>(arr: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
