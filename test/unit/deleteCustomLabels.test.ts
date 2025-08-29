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
import fs from 'node:fs';
import sinon from 'sinon';
import { SourceComponent, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { expect } from 'chai';
import { deleteCustomLabels } from '../../src/shared/functions';

const registry = new RegistryAccess();
// const customLabelsType = registry.getTypeByName('CustomLabels');
const customLabelType = registry.getTypeByName('CustomLabel');

describe('deleteCustomLabels', () => {
  const sandbox = sinon.createSandbox();
  let fsReadStub: sinon.SinonStub;
  let fsWriteStub: sinon.SinonStub;
  let fsUnlinkStub: sinon.SinonStub;

  beforeEach(() => {
    fsWriteStub = sandbox.stub(fs.promises, 'writeFile');
    fsUnlinkStub = sandbox.stub(fs.promises, 'unlink');
    fsReadStub = sandbox
      .stub(fs, 'readFileSync')
      .returns(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
          '    <labels>\n' +
          '        <fullName>DeleteMe</fullName>\n' +
          '        <language>en_US</language>\n' +
          '        <protected>true</protected>\n' +
          '        <shortDescription>DeleteMe</shortDescription>\n' +
          '        <value>Test</value>\n' +
          '    </labels>\n' +
          '    <labels>\n' +
          '        <fullName>KeepMe1</fullName>\n' +
          '        <language>en_US</language>\n' +
          '        <protected>true</protected>\n' +
          '        <shortDescription>KeepMe1</shortDescription>\n' +
          '        <value>Test</value>\n' +
          '    </labels>\n' +
          '    <labels>\n' +
          '        <fullName>KeepMe2</fullName>\n' +
          '        <language>en_US</language>\n' +
          '        <protected>true</protected>\n' +
          '        <shortDescription>KeepMe2</shortDescription>\n' +
          '        <value>Test</value>\n' +
          '    </labels>\n' +
          '</CustomLabels>\n'
      );
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('deleteCustomLabels', () => {
    it('will delete a singular custom label from a file', async () => {
      const labels = [
        {
          type: customLabelType,
          fullName: 'DeleteMe',
        } as SourceComponent,
      ];

      const result = await deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      const resultLabels = result?.CustomLabels.labels.map((label) => label.fullName);
      expect(resultLabels).to.deep.equal(['KeepMe1', 'KeepMe2']);
      expect(fsReadStub.callCount).to.equal(1);
    });
    it('will delete a multiple custom labels from a file', async () => {
      const labels = [
        {
          type: customLabelType,
          fullName: 'KeepMe1',
        },
        {
          type: customLabelType,
          fullName: 'KeepMe2',
        },
      ] as SourceComponent[];

      const result = await deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      const resultLabels = result?.CustomLabels.labels.map((label) => label.fullName);
      expect(resultLabels).to.deep.equal(['DeleteMe']);
      expect(fsReadStub.callCount).to.equal(1);
    });

    it('will delete the file when everything is deleted', async () => {
      const labels = [
        {
          type: customLabelType,
          fullName: 'KeepMe1',
        },
        {
          type: customLabelType,
          fullName: 'KeepMe2',
        },
        {
          type: customLabelType,
          fullName: 'DeleteMe',
        },
      ] as SourceComponent[];

      const result = await deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      expect(result).to.equal(undefined);
      expect(fsUnlinkStub.callCount).to.equal(1);
      expect(fsReadStub.callCount).to.equal(1);
    });

    it('will delete the file when only a single label is present and deleted', async () => {
      fsReadStub.returns(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
          '    <labels>\n' +
          '        <fullName>DeleteMe</fullName>\n' +
          '        <language>en_US</language>\n' +
          '        <protected>true</protected>\n' +
          '        <shortDescription>DeleteMe</shortDescription>\n' +
          '        <value>Test</value>\n' +
          '    </labels>\n' +
          '</CustomLabels>\n'
      );
      const labels = [
        {
          type: customLabelType,
          fullName: 'DeleteMe',
        },
      ] as SourceComponent[];

      const result = await deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      expect(result).to.equal(undefined);
      expect(fsUnlinkStub.callCount).to.equal(1);
      expect(fsReadStub.callCount).to.equal(1);
    });

    it('no custom labels, quick exit and do nothing', async () => {
      const labels = [
        {
          type: { id: 'apexclass', name: 'ApexClass' },
          fullName: 'DeleteMe',
        },
      ] as SourceComponent[];

      const result = await deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      expect(result).to.equal(undefined);
      expect(fsUnlinkStub.callCount).to.equal(0);
      expect(fsWriteStub.callCount).to.equal(0);
      expect(fsReadStub.callCount).to.equal(0);
    });
  });
});
