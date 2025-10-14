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
import { ComponentStatus, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { expect } from 'chai';
import { calculateExpectedSourceMembers } from '../../../src/shared/remote/expectedSourceMembers.js';
import { getMetadataKeyFromFileResponse } from '../../../src/shared/metadataKeys.js';

const registry = new RegistryAccess();
const getKeys = getMetadataKeyFromFileResponse(registry);

describe('expectedSourceMembers', () => {
  it('filters out standard fields and deleted fields on standardObjects but returns custom fields on same object ', () => {
    const input = [
      {
        type: 'CustomField',
        fullName: 'Account.Name',
        filePath: 'src/objects/Account/fields/Name.field-meta.xml',
        state: ComponentStatus.Created,
      },
      {
        type: 'CustomField',
        fullName: 'Account.Deleted_del__c',
        filePath: 'src/objects/Account/fields/Deleted_del__c.field-meta.xml',
        state: ComponentStatus.Created,
      },
      {
        type: 'CustomField',
        fullName: 'Account.Foo__c',
        filePath: 'src/objects/Account/fields/Foo__c.field-meta.xml',
        state: ComponentStatus.Created,
      },
    ];
    const result = calculateExpectedSourceMembers(registry, input);
    expect(result.size).to.equal(1);
    // fields return object, field for their keys
    const input2 = getKeys(input[2]);
    const mdKey = input2.find((f) => f.startsWith('CustomField'));
    if (mdKey) {
      expect(result.get(mdKey)).to.deep.equal(input[2]);
    } else {
      expect(false, 'CustomField metadata not found');
    }
  });

  it('omits aura xml types', () => {
    const input = [
      {
        type: 'AuraDefinitionBundle',
        fullName: 'foo',
        state: ComponentStatus.Created,
        filePath: 'src/aura/foo/foo.cmp-meta.xml',
      },
    ];
    const result = calculateExpectedSourceMembers(registry, input);
    expect(result.size).to.equal(0);
  });

  it('omits Layout only if it contains a %', () => {
    const input = [
      {
        type: 'Layout',
        fullName: 'Account.OKLayout',
        filePath: 'src/layouts/Account-OKLayout.layout-meta.xml',
        state: ComponentStatus.Created,
      },
      {
        type: 'Layout',
        fullName: 'Account.Whate%ver',
        filePath: 'src/layouts/Account-Whate%ver.layout-meta.xml',
        state: ComponentStatus.Created,
      },
    ];
    const result = calculateExpectedSourceMembers(registry, input);
    expect(result.size).to.equal(1);
    expect(result.get(getKeys(input[0])[0])).to.deep.equal(input[0]);
  });

  it('omits namespaced custom labels', () => {
    const input = [
      {
        type: 'CustomLabels',
        fullName: 'ns__Test1',
        filePath: 'src/labels/ns__Account-OKLayout.labels-meta.xml',
        state: ComponentStatus.Created,
      },
    ];
    const result = calculateExpectedSourceMembers(registry, input);
    expect(result.size).to.equal(0);
  });

  it('omits standard profile', () => {
    const input = [
      {
        type: 'Profile',
        fullName: 'Standard',
        filePath: 'src/profiles/Standard.profile-meta.xml',
        state: ComponentStatus.Created,
      },
    ];
    const result = calculateExpectedSourceMembers(registry, input);
    expect(result.size).to.equal(0);
  });
});
