/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import path from 'node:path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { getMetadataKeyFromFileResponse } from '../../../src/shared/metadataKeys';

// this is a NUT to avoid fs-mocking the CustomLabels file that SDR is going to read to getChildren
describe('end-to-end-test for custom labels', () => {
  let session: TestSession;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'repros', 'duplabels'),
      },
      devhubAuthStrategy: 'NONE',
    });
  });

  after(async () => {
    await session?.clean();
  });

  it('translates labels to label[]', () => {
    const testResponse = {
      filePath: path.join(session.project.dir, 'pkg1', 'Test1.labels-meta.xml'),
      type: 'CustomLabels',
      state: ComponentStatus.Created,
      fullName: 'Test1',
    };
    expect(getMetadataKeyFromFileResponse(testResponse)).to.deep.equal(['CustomLabel__Label1']);
  });
});
