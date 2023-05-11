/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'fs';
import * as sinon from 'sinon';
import { SourceComponent } from '@salesforce/source-deploy-retrieve';
import { expect } from 'chai';
import { SourceTracking } from '../../src';

describe('SourceTracking', () => {
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
          type: { id: 'customlabel', name: 'CustomLabel' },
          fullName: 'DeleteMe',
        } as SourceComponent,
      ];

      await SourceTracking.deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      expect(fsWriteStub.firstCall.args[1]).to.not.include('DeleteMe');
      expect(fsWriteStub.firstCall.args[1]).to.include('KeepMe1');
      expect(fsWriteStub.firstCall.args[1]).to.include('KeepMe2');
      expect(fsReadStub.callCount).to.equal(1);
    });
    it('will delete a multiple custom labels from a file', async () => {
      const labels = [
        {
          type: { id: 'customlabel', name: 'CustomLabel' },
          fullName: 'KeepMe1',
        },
        {
          type: { id: 'customlabel', name: 'CustomLabel' },
          fullName: 'KeepMe2',
        },
      ] as SourceComponent[];

      await SourceTracking.deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      expect(fsWriteStub.firstCall.args[1]).to.include('DeleteMe');
      expect(fsWriteStub.firstCall.args[1]).to.not.include('KeepMe1');
      expect(fsWriteStub.firstCall.args[1]).to.not.include('KeepMe2');
      expect(fsReadStub.callCount).to.equal(1);
    });

    it('will delete the file when everything is deleted', async () => {
      const labels = [
        {
          type: { id: 'customlabel', name: 'CustomLabel' },
          fullName: 'KeepMe1',
        },
        {
          type: { id: 'customlabel', name: 'CustomLabel' },
          fullName: 'KeepMe2',
        },
        {
          type: { id: 'customlabel', name: 'CustomLabel' },
          fullName: 'DeleteMe',
        },
      ] as SourceComponent[];

      await SourceTracking.deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
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
          type: { id: 'customlabel', name: 'CustomLabel' },
          fullName: 'DeleteMe',
        },
      ] as SourceComponent[];

      await SourceTracking.deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      expect(fsUnlinkStub.callCount).to.equal(1);
      expect(fsReadStub.callCount).to.equal(1);
    });

    it('will not delete custom labels', async () => {
      const labels = [
        {
          type: { id: 'apexclass', name: 'ApexClass' },
          fullName: 'DeleteMe',
        },
      ] as SourceComponent[];

      await SourceTracking.deleteCustomLabels('labels/CustomLabels.labels-meta.xml', labels);
      expect(fsUnlinkStub.callCount).to.equal(0);
      expect(fsWriteStub.firstCall.args[1]).to.include('DeleteMe');
      expect(fsReadStub.callCount).to.equal(1);
    });
  });
});
