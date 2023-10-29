/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { normalize } from 'node:path';
import { expect } from 'chai';
import { pathIsInFolder } from '../../src/shared/functions';

describe('pathIsInFolder', () => {
  it('does not misidentify partial strings', () => {
    expect(pathIsInFolder(normalize('/foo/bar-extra/baz'), normalize('/foo/bar'))).to.equal(false);
  });

  it('does not misidentify partial strings (inverse)', () => {
    expect(pathIsInFolder(normalize('/foo/bar-extra/baz'), normalize('/foo/bar-extra'))).to.equal(true);
  });

  it('single top-level dir is ok', () => {
    expect(pathIsInFolder(normalize('/foo/bar-extra/baz'), normalize('/foo'))).to.equal(true);
  });

  it('no initial separator on 1st arg is ok', () => {
    expect(pathIsInFolder(normalize('/foo/bar-extra/baz'), 'foo')).to.equal(true);
  });

  it('no initial separator on 2nd arg is ok', () => {
    expect(pathIsInFolder(normalize('foo/bar-extra/baz'), normalize('/foo'))).to.equal(true);
  });

  it('works for deep children', () => {
    expect(pathIsInFolder(normalize('/foo/bar-extra/baz/some/deep/path'), normalize('/foo/bar-extra/baz'))).to.equal(
      true
    );
  });
});
