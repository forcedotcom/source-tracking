/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { expect } from 'chai';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { getMetadataKeyFromFileResponse } from '../../src/shared/metadataKeys';

describe('metadataKeys', () => {
  it('default behavior', () => {
    const fileResponse = {
      fullName: 'Order__c',
      type: 'CustomTab',
      state: ComponentStatus.Created,
      filePath: 'force-app/main/default/tabs/Order__c.tab-meta.xml',
    };

    expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal(['CustomTab__Order__c']);
  });

  describe('lwc', () => {
    it('lwc returns the bundle and the resource pointing to the file', () => {
      const fileResponse = {
        fullName: 'productTileList',
        type: 'LightningComponentBundle',
        state: ComponentStatus.Created,
        filePath: 'force-app/main/default/lwc/productTileList/productTileList.css',
      };
      expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal([
        'LightningComponentResource__productTileList/productTileList.css',
        'LightningComponentBundle__productTileList',
      ]);
    });

    it('lwc handles nested folders for templates', () => {
      const fileResponse = {
        fullName: 'errorPanel',
        type: 'LightningComponentBundle',
        state: ComponentStatus.Created,
        filePath: 'force-app/main/default/lwc/errorPanel/templates/noDataIllustration.html',
      };
      expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal([
        'LightningComponentResource__errorPanel/templates/noDataIllustration.html',
        'LightningComponentBundle__errorPanel',
      ]);
    });
  });

  describe('aura', () => {
    it('aura return the bundle and auraDefinition pointing to the file', () => {
      const fileResponse = {
        fullName: 'pageTemplate_2_7_3',
        type: 'AuraDefinitionBundle',
        state: ComponentStatus.Created,
        filePath: 'force-app/main/default/aura/pageTemplate_2_7_3/pageTemplate_2_7_3.cmp',
      };
      expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal([
        'AuraDefinition__pageTemplate_2_7_3/pageTemplate_2_7_3.cmp',
        'AuraDefinitionBundle__pageTemplate_2_7_3',
      ]);
    });
  });

  describe('object children', () => {
    it('creates a key for the object from a field', () => {
      const fileResponse = {
        fullName: 'Case.Product__c',
        type: 'CustomField',
        state: ComponentStatus.Created,
        filePath: 'force-app/main/default/objects/Case/fields/Product__c.field-meta.xml',
      };
      expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal([
        'CustomObject__Case',
        'CustomField__Case.Product__c',
      ]);
    });
  });
});
