/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { basename, dirname, join, normalize, sep } from 'node:path';
import { ComponentSet, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { Lifecycle } from '@salesforce/core';
import { RemoteSyncInput } from './types';
import { getMetadataKey } from './functions';

// See UT for examples of the complexity this must handle
// keys always use forward slashes, even on Windows
const pathAfterFullName = (fileResponse: RemoteSyncInput): string =>
  fileResponse?.filePath
    ? join(
        dirname(fileResponse.filePath).substring(dirname(fileResponse.filePath).lastIndexOf(fileResponse.fullName)),
        basename(fileResponse.filePath)
      ).replace(/\\/gi, '/')
    : '';

const registry = new RegistryAccess();

// only compute once
const aliasTypes: Array<[string, string]> = registry
  .getAliasTypes()
  .map((aliasType) => [aliasType.name, registry.getTypeByName(aliasType.aliasFor as string).name]);

const reverseAliasTypes = new Map(aliasTypes.map(([alias, type]) => [type, alias]));

// handle all "weird" type/name translation between SourceMember and SDR FileResponse
// These get de-duplicated in a set later, so it's ok to have one per file
export const getMetadataKeyFromFileResponse = (fileResponse: RemoteSyncInput): string[] => {
  // also create an element for the parent object
  if (fileResponse.type === 'CustomField' && fileResponse.filePath) {
    const splits = normalize(fileResponse.filePath).split(sep);
    const objectFolderIndex = splits.indexOf('objects');
    return [
      getMetadataKey('CustomObject', splits[objectFolderIndex + 1]),
      getMetadataKey(fileResponse.type, fileResponse.fullName),
    ];
  }
  // Aura/LWC need to have both the bundle level and file level keys
  if (fileResponse.type === 'LightningComponentBundle' && fileResponse.filePath) {
    return [
      `LightningComponentResource__${pathAfterFullName(fileResponse)}`,
      getMetadataKey(fileResponse.type, fileResponse.fullName),
    ];
  }
  if (fileResponse.type === 'AuraDefinitionBundle' && fileResponse.filePath) {
    return [
      `AuraDefinition__${pathAfterFullName(fileResponse)}`,
      getMetadataKey(fileResponse.type, fileResponse.fullName),
    ];
  }
  // CustomLabels (file) => CustomLabel[] (how they're stored in SourceMembers)
  if (fileResponse.type === 'CustomLabels' && fileResponse.filePath) {
    return ComponentSet.fromSource(fileResponse.filePath)
      .getSourceComponents()
      .toArray()
      .flatMap((component) => component.getChildren().map((child) => getMetadataKey('CustomLabel', child.fullName)));
  }
  // if we've aliased a type, we'll have to possibly sync both types--you can't tell from the sourceComponent retrieved which way it was stored on the server
  if (reverseAliasTypes.has(fileResponse.type)) {
    return [
      getMetadataKey(fileResponse.type, fileResponse.fullName),
      getMetadataKey(reverseAliasTypes.get(fileResponse.type) as string, fileResponse.fullName),
    ];
  }
  // standard key for everything else
  return [getMetadataKey(fileResponse.type, fileResponse.fullName)];
};

export const mappingsForSourceMemberTypesToMetadataType = new Map<string, string>([
  ...aliasTypes,
  ['AuraDefinition', 'AuraDefinitionBundle'],
  ['LightningComponentResource', 'LightningComponentBundle'],
]);

export const registrySupportsType = (type: string): boolean => {
  if (mappingsForSourceMemberTypesToMetadataType.has(type)) {
    return true;
  }
  if (type === 'PicklistValue') {
    /* "PicklistValue" appears occasionally in sourceMembers, but it's not a real, addressable type in the registry
     * It only appears when a picklist value is reactivated, so I'd call this a SourceMember bug
     * We also can't make it a child type in the SDR registry because it it can be a parent of either CustomField/Picklist OR GlobalValueSet
     * in both parent cases (GVS and CustomField), the the parent is marked as changed in SourceMembers, to the behavior is ok igoring the PicklistValue
     * This suppresses the warning, and could be removed if the SourceMember bug is fixed
     */
    return false;
  }
  try {
    // this must use getTypeByName because findType doesn't support addressable child types (ex: customField!)
    registry.getTypeByName(type);
    return true;
  } catch (e) {
    void Lifecycle.getInstance().emitWarning(`Unable to find type ${type} in registry`);
    return false;
  }
};
