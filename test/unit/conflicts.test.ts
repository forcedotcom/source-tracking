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
import sinon from 'sinon';
import { expect } from 'chai';
import { ForceIgnore, ComponentSet, RegistryAccess } from '@salesforce/source-deploy-retrieve';
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
    const registry = new RegistryAccess();
    const base = {
      registry,
      forceIgnore: forceIgnoreStub,
      projectPath: 'foo',
    };
    it('works on empty changes', () => {
      expect(
        getDedupedConflictsFromChanges({
          localChanges: [],
          remoteChanges: [],
          ...base,
        })
      ).to.deep.equal([]);
    });
    it('returns nothing when only 1 side is changed', () => {
      expect(
        getDedupedConflictsFromChanges({
          localChanges: [class1Local],
          remoteChanges: [],
          ...base,
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
          ...base,
        })
      ).to.deep.equal([]);
    });

    it('de-dupes local and remote change where names match', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { filenames, ...simplifiedResult } = class1Local;
      expect(
        getDedupedConflictsFromChanges({
          localChanges: [class1Local],
          remoteChanges: [{ origin: 'remote', name: 'MyClass', type: 'ApexClass' }],
          ...base,
        })
      ).to.deep.equal([{ ...simplifiedResult, origin: 'remote' }]);
    });
  });
});
