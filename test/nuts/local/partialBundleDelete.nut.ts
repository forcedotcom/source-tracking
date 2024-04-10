/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import path from 'node:path';
import fs from 'node:fs';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import sinon from 'sinon';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { getComponentSets } from '../../../src/shared/localComponentSetArray';

describe('Bundle-like types delete', () => {
  let session: TestSession;

  before(async () => {
    session = await TestSession.create({
      project: {
        sourceDir: path.join('test', 'nuts', 'repros', 'partialBundleDelete'),
      },
      devhubAuthStrategy: 'NONE',
    });
  });

  // We need a sinon sandbox to stub the file system to make it look like we
  // deleted some files.
  const sandbox = sinon.createSandbox();
  const registry = new RegistryAccess();
  after(async () => {
    await session?.clean();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns components for deploy with partial LWC delete', () => {
    const lwcTestCompDir = path.join(session.project.dir, 'force-app', 'lwc', 'testComp');
    const lwcHtmlFile = path.join(lwcTestCompDir, 'myComp.html');
    const lwcJsFile = path.join(lwcTestCompDir, 'myComp.js');
    const lwcMetaFile = path.join(lwcTestCompDir, 'myComp.js-meta.xml');

    const compSets = getComponentSets({
      groupings: [
        {
          path: path.join(session.project.dir, 'force-app', 'lwc'),
          nonDeletes: [lwcJsFile, lwcMetaFile],
          deletes: [lwcHtmlFile],
        },
      ],
      registry,
    });

    expect(compSets.length).to.equal(1);
    compSets.forEach((cs) => {
      expect(cs.getTypesOfDestructiveChanges()).to.deep.equal([]);
      const comps = cs.getSourceComponents().toArray();
      expect(comps[0].isMarkedForDelete()).to.equal(false);
    });
  });

  it('returns components for delete for full LWC delete', () => {
    // We stub this so it appears that we deleted all the LWC files
    sandbox.stub(fs, 'existsSync').returns(false);
    const lwcTestCompDir = path.join(session.project.dir, 'force-app', 'lwc', 'testComp');
    const lwcHtmlFile = path.join(lwcTestCompDir, 'myComp.html');
    const lwcJsFile = path.join(lwcTestCompDir, 'myComp.js');
    const lwcMetaFile = path.join(lwcTestCompDir, 'myComp.js-meta.xml');

    const compSets = getComponentSets({
      groupings: [
        {
          path: path.join(session.project.dir, 'force-app', 'lwc'),
          nonDeletes: [],
          deletes: [lwcHtmlFile, lwcJsFile, lwcMetaFile],
        },
      ],
      registry,
    });

    expect(compSets.length).to.equal(1);
    compSets.forEach((cs) => {
      expect(cs.getTypesOfDestructiveChanges()).to.deep.equal(['post']);
      const comps = cs.getSourceComponents().toArray();
      expect(comps[0].isMarkedForDelete()).to.equal(true);
    });
  });

  it('returns components for deploy with partial StaticResource delete', () => {
    const srDir = path.join(session.project.dir, 'force-app', 'staticresources');
    const srFile1 = path.join(srDir, 'ZippedResource', 'file1.json');
    const srFile2 = path.join(srDir, 'ZippedResource', 'file2.json');
    const srMetaFile = path.join(srDir, 'ZippedResource.resource-meta.xml');

    const compSets = getComponentSets({
      groupings: [
        {
          path: srDir,
          nonDeletes: [srMetaFile, srFile2],
          deletes: [srFile1],
        },
      ],
      registry,
    });

    expect(compSets.length).to.equal(1);
    compSets.forEach((cs) => {
      expect(cs.getTypesOfDestructiveChanges()).to.deep.equal([]);
      const comps = cs.getSourceComponents().toArray();
      expect(comps[0].isMarkedForDelete()).to.equal(false);
    });
  });

  it('returns components for delete for full StaticResource delete', () => {
    // We stub this so it appears that we deleted all the ZippedResource static resource files
    sandbox.stub(fs, 'existsSync').returns(false);
    const srDir = path.join(session.project.dir, 'force-app', 'staticresources');
    const srFile1 = path.join(srDir, 'ZippedResource', 'file1.json');
    const srFile2 = path.join(srDir, 'ZippedResource', 'file2.json');
    const srMetaFile = path.join(srDir, 'ZippedResource.resource-meta.xml');

    const compSets = getComponentSets({
      groupings: [
        {
          path: srDir,
          nonDeletes: [],
          deletes: [srFile1, srFile2, srMetaFile],
        },
      ],
      registry,
    });

    expect(compSets.length).to.equal(1);
    compSets.forEach((cs) => {
      expect(cs.getTypesOfDestructiveChanges()).to.deep.equal(['post']);
      const comps = cs.getSourceComponents().toArray();
      expect(comps[0].isMarkedForDelete()).to.equal(true);
    });
  });

  it('returns components for deploy with partial DigitalExperienceBundle delete', () => {
    const debDir = path.join(session.project.dir, 'force-app', 'digitalExperiences', 'site', 'Xcel_Energy1');
    const deFile1 = path.join(debDir, 'sfdc_cms__view', 'home', 'content.json');

    const compSets = getComponentSets({
      groupings: [
        {
          path: debDir,
          nonDeletes: [],
          deletes: [deFile1],
        },
      ],
      registry,
    });

    expect(compSets.length).to.equal(1);
    compSets.forEach((cs) => {
      expect(cs.getTypesOfDestructiveChanges()).to.deep.equal([]);
      const comps = cs.getSourceComponents().toArray();
      expect(comps[0].isMarkedForDelete()).to.equal(false);
    });
  });

  it('returns components for deploy with partial ExperienceBundle delete', () => {
    const ebDir = path.join(session.project.dir, 'force-app', 'experiences', 'fooEB');
    const eFile1 = path.join(ebDir, 'views', 'login.json');
    const eFile2 = path.join(ebDir, 'routes', 'login.json');

    const compSets = getComponentSets({
      groupings: [
        {
          path: ebDir,
          nonDeletes: [eFile2],
          deletes: [eFile1],
        },
      ],
      registry,
    });

    expect(compSets.length).to.equal(1);
    compSets.forEach((cs) => {
      expect(cs.getTypesOfDestructiveChanges()).to.deep.equal([]);
      const comps = cs.getSourceComponents().toArray();
      expect(comps[0].isMarkedForDelete()).to.equal(false);
    });
  });
});
