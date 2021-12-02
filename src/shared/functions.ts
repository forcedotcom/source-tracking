/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

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
