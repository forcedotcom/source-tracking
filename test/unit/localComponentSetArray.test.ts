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

import { expect } from 'chai';
import { getGroupedFiles } from '../../src/shared/localComponentSetArray.js';

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

  it('handles empty packageDirs gracefully', () => {
    const result = getGroupedFiles({
      packageDirs: [],
      nonDeletes: ['one/file1.xml'],
      deletes: ['one/delete.xml'],
    });

    expect(result).to.deep.equal([]);
  });

  it('handles mixed valid and invalid paths in nonDeletes and deletes', () => {
    const result = getGroupedFiles(
      {
        packageDirs,
        nonDeletes: ['one/file1.xml', 'invalid/file.xml'],
        deletes: ['two/delete.xml', 'invalid/delete.xml'],
      },
      true
    );

    expect(result).to.deep.equal([
      {
        path: 'one',
        nonDeletes: ['one/file1.xml'],
        deletes: [],
      },
      {
        path: 'two',
        nonDeletes: [],
        deletes: ['two/delete.xml'],
      },
    ]);
  });

  it('handles sequential flag as false with empty nonDeletes and deletes', () => {
    const result = getGroupedFiles(
      {
        packageDirs,
        nonDeletes: [],
        deletes: [],
      },
      false
    );

    expect(result).to.deep.equal([]);
  });
});
