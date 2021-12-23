/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'path';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { fs, Org, SfdxProject } from '@salesforce/core';
import { getString } from '@salesforce/ts-types';
import { SourceTracking } from '../../src/sourceTracking';

const getSTLInstance = async (session: TestSession): Promise<SourceTracking> => {
  return SourceTracking.create({
    org: await Org.create({ aliasOrUsername: getString(session, 'setup[0].result.username') }),
    project: await SfdxProject.resolve(session.project.dir),
  });
};

describe('sourceTracking: localChangesAsComponentSet', () => {
  let session: TestSession;
  let stl: SourceTracking;
  before(async () => {
    session = await TestSession.create({
      project: {
        gitClone: 'https://github.com/salesforcecli/sample-project-multiple-packages',
      },
      // creating an org because a default org/id is required for source tracking files
      setupCommands: [`sfdx force:org:create -d 1 -s -f ${path.join('config', 'project-scratch-def.json')}`],
    });
    stl = await getSTLInstance(session);
    expect(
      await stl.getChanges<string>({ origin: 'local', format: 'string', state: 'nondelete' })
    ).to.have.length.greaterThan(10);
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

  it('byPkgDir => 2 component when one pkgDir has no non-ignored files', async () => {
    // will forceignore an entire directory--effectively, a pkgDir with no files found
    const forceIgnoreLocation = path.join(session.project.dir, '.forceignore');
    await fs.writeFile(forceIgnoreLocation, path.join('my-app', '*'));

    // new instance of STL since we changed the forceignore (it'd be cached from previous tests)
    stl = await getSTLInstance(session);
    const cs = await stl.localChangesAsComponentSet(true);
    expect(cs.length).to.equal(2);
  });

  after(async () => {
    await session?.clean();
  });
});
