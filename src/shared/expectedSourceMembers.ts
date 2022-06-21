/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { getMetadataKeyFromFileResponse } from './metadataKeys';
import { RemoteSyncInput } from './types';

const typesToNoPollFor = [
  'CustomObject',
  'EmailFolder',
  'EmailTemplateFolder',
  'StandardValueSet',
  'Portal',
  'StandardValueSetTranslation',
  'SharingRules',
  'SharingCriteriaRule',
  'GlobalValueSetTranslation',
  'AssignmentRules',
];

const isEncodedTypeWithPercentSign = (type: string, filePath?: string): boolean =>
  ['Layout', 'Profile', 'HomePageComponent', 'HomePageLayout'].includes(type) && Boolean(filePath?.includes('%'));

// aura xml aren't tracked as SourceMembers
const isSpecialAuraXml = (filePath?: string): boolean =>
  Boolean(
    filePath &&
      (filePath.endsWith('.cmp-meta.xml') ||
        filePath.endsWith('.tokens-meta.xml') ||
        filePath.endsWith('.evt-meta.xml') ||
        filePath.endsWith('.app-meta.xml') ||
        filePath.endsWith('.intf-meta.xml'))
  );

export const calculateExpectedSourceMembers = (expectedMembers: RemoteSyncInput[]): Map<string, RemoteSyncInput> => {
  const outstandingSourceMembers = new Map<string, RemoteSyncInput>();

  expectedMembers
    .filter(
      (fileResponse) =>
        // unchanged files will never be in the sourceMembers.  Not really sure why SDR returns them.
        fileResponse.state !== ComponentStatus.Unchanged &&
        // if a listView is the only change inside an object, the object won't have a sourceMember change.  We won't wait for those to be found
        // we don't know which email folder type might be there, so don't require either
        // Portal doesn't support source tracking, according to the coverage report
        !typesToNoPollFor.includes(fileResponse.type) &&
        // don't wait for standard fields on standard objects
        !(fileResponse.type === 'CustomField' && !fileResponse.filePath?.includes('__c')) &&
        // deleted fields
        !(fileResponse.type === 'CustomField' && fileResponse.filePath?.includes('_del__c')) &&
        // built-in report type ReportType__screen_flows_prebuilt_crt
        !(fileResponse.type === 'ReportType' && fileResponse.filePath?.includes('screen_flows_prebuilt_crt')) &&
        // they're settings to mdapi, and FooSettings in sourceMembers
        !fileResponse.type.includes('Settings') &&
        // mdapi encodes these, sourceMembers don't have encoding
        !isEncodedTypeWithPercentSign(fileResponse.type, fileResponse.filePath) &&
        // namespaced labels and CMDT don't resolve correctly
        !(['CustomLabels', 'CustomMetadata'].includes(fileResponse.type) && fileResponse.filePath?.includes('__')) &&
        // don't wait on workflow children
        !fileResponse.type.startsWith('Workflow') &&
        !isSpecialAuraXml(fileResponse.filePath)
    )
    .map((member) => {
      getMetadataKeyFromFileResponse(member)
        // remove some individual members known to not work with tracking even when their type does
        .filter(
          (key) =>
            // CustomObject could have been re-added by the key generator from one of its fields
            !key.startsWith('CustomObject') &&
            key !== 'Profile__Standard' &&
            key !== 'CustomTab__standard-home' &&
            key !== 'AssignmentRules__Case' &&
            key !== 'ListView__CollaborationGroup.All_ChatterGroups'
        )
        .map((key) => outstandingSourceMembers.set(key, member));
    });

  return outstandingSourceMembers;
};
