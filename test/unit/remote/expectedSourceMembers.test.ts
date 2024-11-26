/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { expect } from 'chai';
import { calculateExpectedSourceMembers } from '../../../src/shared/remote/expectedSourceMembers';
import { getMetadataKeyFromFileResponse } from '../../../src/shared/metadataKeys';

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
    const result = calculateExpectedSourceMembers(input);
    expect(result.size).to.equal(1);
    // fields return object, field for their keys
    const input2 = getMetadataKeyFromFileResponse(input[2]);
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
    const result = calculateExpectedSourceMembers(input);
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
    const result = calculateExpectedSourceMembers(input);
    expect(result.size).to.equal(1);
    expect(result.get(getMetadataKeyFromFileResponse(input[0])[0])).to.deep.equal(input[0]);
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
    const result = calculateExpectedSourceMembers(input);
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
    const result = calculateExpectedSourceMembers(input);
    expect(result.size).to.equal(0);
  });
});
