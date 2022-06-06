/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as sinon from 'sinon';
import { expect } from 'chai';
import { ForceIgnore } from '@salesforce/source-deploy-retrieve';
import { getDedupedConflictsFromChanges } from '../../src/shared/conflicts';
import { ChangeResult } from '../../src/shared/types';

const class1Local: ChangeResult = {
  origin: 'local',
  name: 'MyClass',
  type: 'ApexClass',
  filenames: ['foo/classes/MyClass.cls', 'foo/classes/MyClass.cls-meta.xml'],
};

describe('conflicts functions', () => {
  const sandbox = sinon.createSandbox();
  const forceIgnoreStub = sandbox.stub(ForceIgnore.prototype);

  after(() => {
    sandbox.restore();
  });

  describe('filter component set', () => {
    it('matches a conflict in a component set');
    it('returns nothing when no matches');
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
