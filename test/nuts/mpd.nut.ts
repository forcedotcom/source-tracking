/*
 * Copyright 2026, Salesforce, Inc.
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
import fs from 'node:fs';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { Org, SfProject } from '@salesforce/core';
import { SourceTracking } from '../../src/sourceTracking';

const getSTLInstance = async (session: TestSession): Promise<SourceTracking> =>
  SourceTracking.create({
    org: await Org.create({ aliasOrUsername: session.orgs.get('default')?.username }),
    project: await SfProject.resolve(session.project.dir),
  });

describe('sourceTracking: localChangesAsComponentSet', () => {
  let session: TestSession;
  let stl: SourceTracking;
  before(async () => {
    session = await TestSession.create({
      project: {
        gitClone: 'https://github.com/salesforcecli/sample-project-multiple-packages',
      },
      // creating an org because a default org/id is required for source tracking files
      scratchOrgs: [
        {
          config: path.join('config', 'project-scratch-def.json'),
          duration: 1,
          setDefault: true,
        },
      ],
      devhubAuthStrategy: 'AUTO',
    });
    stl = await getSTLInstance(session);
    // these 2 lines help debug path issues in
    const stlChanges = await stl.getChanges({ origin: 'local', format: 'string', state: 'nondelete' });
    expect(stlChanges, stlChanges.join(',')).to.have.length.greaterThan(10);
  });

  it('!byPkgDir => 1 componentSet', async () => {
    const cs = await stl.localChangesAsComponentSet();
    expect(cs.length).to.equal(1);
    expect(cs[0].getSourceComponents().toArray().length).greaterThan(10);
  });

  it('byPkgDir => 3 componentSet', async () => {
    const cs = await stl.localChangesAsComponentSet(true);
    expect(cs.length).to.equal(3);
    expect(cs[0].getSourceComponents().toArray()).to.have.length(6);
    expect(cs[1].getSourceComponents().toArray()).to.have.length(5);
    expect(cs[2].getSourceComponents().toArray()).to.have.length(3);
  });

  it('byPkgDir => 3 component sets and shows ignored files', async () => {
    // will forceignore an entire directory--effectively, a pkgDir with no files found
    const forceIgnoreLocation = path.join(session.project.dir, '.forceignore');
    await fs.promises.writeFile(forceIgnoreLocation, 'my-app/*');

    // new instance of STL since we changed the forceignore (it'd be cached from previous tests)
    stl = await getSTLInstance(session);
    const cs = await stl.localChangesAsComponentSet(true);
    expect(cs.length).to.equal(3);
    expect(cs[0].getSourceComponents().toArray()).to.have.length(6);
    expect(cs[2].getSourceComponents().toArray()).to.have.length(3);

    // the middle componentSet had everything ignored.
    expect(cs[1].getSourceComponents().toArray()).to.have.length(0);
    // those files instead show up in the ignored paths
    // 1 label + 2 fields in objects + (2 classes * 2 files) = 4
    expect(cs[1].forceIgnoredPaths).to.have.length(7);
  });

  after(async () => {
    await session?.clean();
  });
});
