/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import { RemoteSyncInput } from './types';
import { getMetadataKey } from './functions';

// LWC can have child folders (ex: dynamic templates like /templates/noDataIllustration.html
const pathAfterFullName = (fileResponse: RemoteSyncInput): string =>
  fileResponse && fileResponse.filePath
    ? fileResponse.filePath.substr(fileResponse.filePath.indexOf(fileResponse.fullName)).replace(/\\/gi, '/')
    : '';

// handle all "weird" type/name translation between SourceMember and SDR FileResponse
// These get de-duplicated in a set later, so it's ok to have one per file
export const getMetadataKeyFromFileResponse = (fileResponse: RemoteSyncInput): string[] => {
  // also create an element for the parent object
  if (fileResponse.type === 'CustomField' && fileResponse.filePath) {
    const splits = path.normalize(fileResponse.filePath).split(path.sep);
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
  // these might have been emailFolder or emailTemplateFolder on the server, and we can't tell from the file path/name/type, so we'll set BOTH in source tracking
  if (fileResponse.type === 'EmailFolder' && fileResponse.filePath) {
    return [
      getMetadataKey('EmailFolder', fileResponse.fullName),
      getMetadataKey('EmailTemplateFolder', fileResponse.fullName),
    ];
  }
  // standard key
  return [getMetadataKey(fileResponse.type, fileResponse.fullName)];
};

export const mappingsForSourceMemberTypesToMetadataType = new Map<string, string>([
  ['AuraDefinition', 'AuraDefinitionBundle'],
  ['LightningComponentResource', 'LightningComponentBundle'],
  ['EmailTemplateFolder', 'EmailFolder'],
]);
