/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { ForceIgnore, MetadataComponent, MetadataMember, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { SfError } from '@salesforce/core';
import { filePathsFromMetadataComponent } from '@salesforce/source-deploy-retrieve/lib/src/utils/filePathGenerator';
import { ChangeResult } from './types';
import { isChangeResultWithNameAndType } from './guards';
import { ChangeResultWithNameAndType } from './types';
import { forceIgnoreDenies, changeResultToMetadataComponent } from './functions';

export const removeIgnored = (
  changeResults: ChangeResult[],
  forceIgnore: ForceIgnore,
  defaultPkgDir: string
): MetadataMember[] => {
  const registry = new RegistryAccess();
  return changeResults
    .map(ensureNameAndType)
    .map(changeResultToMetadataComponent(registry))
    .filter((mc) => !filePathsFromMetadataComponent(mc, defaultPkgDir).some(forceIgnoreDenies(forceIgnore)))
    .map(metadataComponentToMetadataMember);
};

const metadataComponentToMetadataMember = (mc: MetadataComponent): MetadataMember => ({
  type: mc.type.name,
  fullName: mc.fullName,
});

export const ensureNameAndType = (cr: ChangeResult): ChangeResultWithNameAndType => {
  if (isChangeResultWithNameAndType(cr)) {
    return cr;
  }
  throw new SfError(`Change Result is missing name or type: ${JSON.stringify(cr)}`);
};
