/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { RemoteSyncInput } from './types';
import { getMetadataKey } from './remoteSourceTrackingService';

// handle all "weird" type/name translation between SourceMember and SDR FileResponse
export const getMetadataKeyFromFileResponse = (fileResponse: RemoteSyncInput): string[] => {
  // LWC can have child folders (ex: dynamic templates like LightningComponentResource__errorPanel/templates/noDataIllustration.html
  const pathAfterFullName = (): string =>
    fileResponse && fileResponse.filePath
      ? fileResponse.filePath.substr(fileResponse.filePath.indexOf(fileResponse.fullName))
      : '';

  // Aura/LWC need to have both the bundle level and file level keys
  // These get de-duplicated in a set later
  if (fileResponse.type === 'LightningComponentBundle' && fileResponse.filePath) {
    return [
      `LightningComponentResource__${pathAfterFullName()}`,
      getMetadataKey(fileResponse.type, fileResponse.fullName),
    ];
  }
  if (fileResponse.type === 'AuraDefinitionBundle' && fileResponse.filePath) {
    return [`AuraDefinition__${pathAfterFullName()}`, getMetadataKey(fileResponse.type, fileResponse.fullName)];
  }

  // standard key
  return [getMetadataKey(fileResponse.type, fileResponse.fullName)];
};
