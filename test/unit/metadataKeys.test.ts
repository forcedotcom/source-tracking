/*
 * Copyright 2025, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { expect } from 'chai';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { getMetadataKeyFromFileResponse, registrySupportsType } from '../../src/shared/metadataKeys.js';

describe('metadataKeys', () => {
  it('default behavior', () => {
    const fileResponse = {
      fullName: 'Order__c',
      type: 'CustomTab',
      state: ComponentStatus.Created,
      filePath: 'force-app/main/default/tabs/Order__c.tab-meta.xml',
    };

    expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal(['CustomTab###Order__c']);
  });

  describe('lwc', () => {
    it('lwc in folder of the same name', () => {
      const fileResponse = {
        fullName: 'productTileList',
        type: 'LightningComponentBundle',
        state: ComponentStatus.Created,
        filePath: 'force-app/main/productTileList/lwc/productTileList/productTileList.css',
      };
      expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal([
        'LightningComponentResource###productTileList/productTileList.css',
        'LightningComponentBundle###productTileList',
      ]);
    });

    it('lwc returns the bundle and the resource pointing to the file', () => {
      const fileResponse = {
        fullName: 'productTileList',
        type: 'LightningComponentBundle',
        state: ComponentStatus.Created,
        filePath: 'force-app/main/default/lwc/productTileList/productTileList.css',
      };
      expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal([
        'LightningComponentResource###productTileList/productTileList.css',
        'LightningComponentBundle###productTileList',
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
        'LightningComponentResource###errorPanel/templates/noDataIllustration.html',
        'LightningComponentBundle###errorPanel',
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
        'AuraDefinition###pageTemplate_2_7_3/pageTemplate_2_7_3.cmp',
        'AuraDefinitionBundle###pageTemplate_2_7_3',
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
        'CustomObject###Case',
        'CustomField###Case.Product__c',
      ]);
    });
  });

  describe('alias types', () => {
    it('creates a key for the type and one for its alias', () => {
      const fileResponse = {
        fullName: 'ETF_WTF',
        type: 'EmailFolder',
        state: ComponentStatus.Created,
        filePath: 'force-app/main/default/email/ETF_WTF.emailFolder-meta.xml',
      };
      expect(getMetadataKeyFromFileResponse(fileResponse)).to.deep.equal([
        'EmailFolder###ETF_WTF',
        'EmailTemplateFolder###ETF_WTF',
      ]);
    });
  });
});

describe('registrySupportsType', () => {
  it('custom mapped types', () => {
    expect(registrySupportsType()('AuraDefinition')).to.equal(true);
    expect(registrySupportsType()('LightningComponentResource')).to.equal(true);
  });
  it('other real types types', () => {
    expect(registrySupportsType()('CustomObject')).to.equal(true);
    expect(registrySupportsType()('ApexClass')).to.equal(true);
  });
  it('bad type returns false and emits warning', async () => {
    const warningEmitted: string[] = [];
    const badType = 'NotARealType';
    const { Lifecycle } = await import('@salesforce/core');
    Lifecycle.getInstance().onWarning(async (w): Promise<void> => {
      warningEmitted.push(w);
      return Promise.resolve();
    });
    expect(registrySupportsType()(badType)).to.equal(false);
    expect(
      warningEmitted.some((w) => w.includes(badType)),
      'warning not emitted'
    ).to.equal(true);
  });
});
