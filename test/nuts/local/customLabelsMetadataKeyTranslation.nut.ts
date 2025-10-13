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
import path from 'node:path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { getMetadataKeyFromFileResponse } from '../../../src/shared/metadataKeys.js';

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
    expect(getMetadataKeyFromFileResponse(testResponse)).to.deep.equal(['CustomLabel###Label1']);
  });
});
