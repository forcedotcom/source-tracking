/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { expect } from 'chai';
import { getGroupedFiles } from '../../src/shared/localComponentSetArray';

const packageDirs = [
  { name: 'one', fullPath: 'test/path/one', path: 'one' },
  { name: 'two', fullPath: 'test/path/two', path: 'two' },
];

describe('groupings', () => {
  it('returns multiple groupings by pkgDir for sequential', () => {
    const result = getGroupedFiles(
      {
        packageDirs,
        nonDeletes: ['one/file1.xml', 'two/file2.xml'],
        deletes: ['one/delete.xml', 'two/delete.xml'],
      },
      true
    );

    expect(result).to.deep.equal([
      {
        path: 'one',
        nonDeletes: ['one/file1.xml'],
        deletes: ['one/delete.xml'],
      },
      {
        path: 'two',
        nonDeletes: ['two/file2.xml'],
        deletes: ['two/delete.xml'],
      },
    ]);
  });
  it('returns one big grouping when not sequential', () => {
    const result = getGroupedFiles({
      packageDirs,
      nonDeletes: ['one/file1.xml', 'two/file2.xml'],
      deletes: ['one/delete.xml', 'two/delete.xml'],
    });

    expect(result).to.deep.equal([
      {
        path: 'one;two',
        nonDeletes: ['one/file1.xml', 'two/file2.xml'],
        deletes: ['one/delete.xml', 'two/delete.xml'],
      },
    ]);
  });
  it('ignored stuff outside pkgDirs for sequential', () => {
    const result = getGroupedFiles(
      {
        packageDirs,
        nonDeletes: ['one/file1.xml', 'three/file2.xml'],
        deletes: ['one/delete.xml', 'three/delete.xml'],
      },
      true
    );

    expect(result).to.deep.equal([
      {
        path: 'one',
        nonDeletes: ['one/file1.xml'],
        deletes: ['one/delete.xml'],
      },
    ]);
  });
  describe('filters', () => {
    it('retains deploy-only groupings', () => {
      const result = getGroupedFiles({
        packageDirs,
        nonDeletes: ['one/file1.xml', 'two/file2.xml'],
        deletes: [],
      });

      expect(result).to.deep.equal([
        {
          path: 'one;two',
          nonDeletes: ['one/file1.xml', 'two/file2.xml'],
          deletes: [],
        },
      ]);
    });
    it('retains delete-only groupings', () => {
      const result = getGroupedFiles({
        packageDirs,
        deletes: ['one/file1.xml', 'two/file2.xml'],
        nonDeletes: [],
      });

      expect(result).to.deep.equal([
        {
          path: 'one;two',
          deletes: ['one/file1.xml', 'two/file2.xml'],
          nonDeletes: [],
        },
      ]);
    });
    it('filters out empty groupings', () => {
      expect(
        getGroupedFiles({
          packageDirs,
          nonDeletes: [],
          deletes: [],
        })
      ).to.have.length(0);
    });
  });
});
