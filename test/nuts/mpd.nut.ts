/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'path';
import * as fs from 'fs';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { Org, SfProject } from '@salesforce/core';
import { getString } from '@salesforce/ts-types';
import { SourceTracking } from '../../src/sourceTracking';

const getSTLInstance = async (session: TestSession): Promise<SourceTracking> =>
  SourceTracking.create({
    org: await Org.create({ aliasOrUsername: getString(session, 'setup[0].result.username') }),
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
    await fs.promises.writeFile(forceIgnoreLocation, path.join('my-app', '*'));

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
