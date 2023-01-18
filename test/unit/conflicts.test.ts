/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import * as sinon from 'sinon';
import { expect } from 'chai';
import { ForceIgnore, ComponentSet } from '@salesforce/source-deploy-retrieve';
import { findConflictsInComponentSet, getDedupedConflictsFromChanges } from '../../src/shared/conflicts';
import { ChangeResult } from '../../src/shared/types';

const clsFullName = 'MyClass';
const clsType = 'ApexClass';
const file1cls = 'foo/classes/MyClass.cls';
const file1meta = 'foo/classes/MyClass.cls-meta.xml';
const class1Local: ChangeResult = {
  origin: 'local',
  name: clsFullName,
  type: clsType,
  filenames: [file1cls, file1meta],
};

describe('conflicts functions', () => {
  const sandbox = sinon.createSandbox();
  const forceIgnoreStub = sandbox.stub(ForceIgnore.prototype);

  after(() => {
    sandbox.restore();
  });

  describe('filter component set', () => {
    it('matches a conflict in a component set', () => {
      const cs = new ComponentSet([{ fullName: clsFullName, type: clsType }]);
      expect(findConflictsInComponentSet(cs, [class1Local])).to.deep.equal([
        {
          filePath: path.join(__dirname, '..', '..', file1cls),
          fullName: class1Local.name,
          state: 'Conflict',
          type: class1Local.type,
        },
        {
          filePath: path.join(__dirname, '..', '..', file1meta),
          fullName: class1Local.name,
          state: 'Conflict',
          type: class1Local.type,
        },
      ]);
    });
    it('returns nothing when no matches', () => {
      const cs = new ComponentSet();
      expect(findConflictsInComponentSet(cs, [class1Local])).to.deep.equal([]);
    });
  });
  describe('dedupe', () => {
    it('works on empty changes', () => {
      expect(
        getDedupedConflictsFromChanges({
          localChanges: [],
          remoteChanges: [],
          projectPath: 'foo',
          forceIgnore: forceIgnoreStub,
        })
      ).to.deep.equal([]);
    });
    it('returns nothing when only 1 side is changed', () => {
      expect(
        getDedupedConflictsFromChanges({
          localChanges: [class1Local],
          remoteChanges: [],
          projectPath: 'foo',
          forceIgnore: forceIgnoreStub,
        })
      ).to.deep.equal([]);
    });
    it('does not return non-matching changes', () => {
      expect(
        getDedupedConflictsFromChanges({
          localChanges: [class1Local],
          remoteChanges: [
            {
              origin: 'remote',
              name: 'OtherClass',
              type: 'ApexClass',
              filenames: ['foo/classes/OtherClass.cls', 'foo/classes/OtherClass.cls-meta.xml'],
            },
          ],
          projectPath: 'foo',
          forceIgnore: forceIgnoreStub,
        })
      ).to.deep.equal([]);
    });

    it('de-dupes local and remote change where names match', () => {
      const { filenames, ...simplifiedResult } = class1Local;
      expect(
        getDedupedConflictsFromChanges({
          localChanges: [class1Local],
          remoteChanges: [{ origin: 'remote', name: 'MyClass', type: 'ApexClass' }],
          projectPath: 'foo',
          forceIgnore: forceIgnoreStub,
        })
      ).to.deep.equal([{ ...simplifiedResult, origin: 'remote' }]);
    });
  });
});
