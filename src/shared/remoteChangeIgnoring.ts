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

export const changeResultToMetadataComponent = (
  cr: ChangeResult,
  registry: RegistryAccess = new RegistryAccess()
): MetadataComponent => {
  if (!cr.name || !cr.type) {
    throw new SfError(`Change Result is missing name or type: ${JSON.stringify(cr)}`);
  }

  return {
    fullName: cr.name,
    type: registry.getTypeByName(cr.type),
  };
};

export const removeIgnored = (
  changeResults: ChangeResult[],
  forceIgnore: ForceIgnore,
  defaultPkgDir: string
): MetadataMember[] => {
  const registry = new RegistryAccess();
  return changeResults
    .map((cr) => changeResultToMetadataComponent(cr, registry))
    .filter((mc) => !filePathsFromMetadataComponent(mc, defaultPkgDir).some((f) => forceIgnore.denies(f)))
    .map((mc) => ({ type: mc.type.name, fullName: mc.fullName }));
};

export const remoteChangeToMetadataMember = (cr: ChangeResult): MetadataMember => {
  if (!cr.name || !cr.type) {
    throw new SfError(`Change Result is missing name or type: ${JSON.stringify(cr)}`);
  }

  return {
    fullName: cr.name,
    type: cr.type,
  };
};
