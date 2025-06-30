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
    expect(pathIsInFolder(normalize('/foo/bar'))(normalize('/foo/bar-extra/baz'))).to.equal(false);
  });

  it('does not misidentify partial strings (inverse)', () => {
    expect(pathIsInFolder(normalize('/foo/bar-extra'))(normalize('/foo/bar-extra/baz'))).to.equal(true);
  });

  it('single top-level dir is ok', () => {
    expect(pathIsInFolder(normalize('/foo'))(normalize('/foo/bar-extra/baz'))).to.equal(true);
  });

  it('no initial separator on 1st arg is ok', () => {
    expect(pathIsInFolder('foo')(normalize('/foo/bar-extra/baz'))).to.equal(true);
  });

  it('no initial separator on 2nd arg is ok', () => {
    expect(pathIsInFolder(normalize('/foo'))(normalize('foo/bar-extra/baz'))).to.equal(true);
  });

  it('works for deep children', () => {
    expect(pathIsInFolder(normalize('/foo/bar-extra/baz'))(normalize('/foo/bar-extra/baz/some/deep/path'))).to.equal(
      true
    );
  });

  it('returns false for completely unrelated paths', () => {
    expect(pathIsInFolder(normalize('/foo/bar'))(normalize('/baz/qux'))).to.equal(false);
  });

  it('handles relative paths correctly', () => {
    expect(pathIsInFolder('foo/bar')(normalize('foo/bar/baz'))).to.equal(true);
    expect(pathIsInFolder('foo/bar')(normalize('foo/baz'))).to.equal(false);
  });

  it('handles empty folder path gracefully', () => {
    expect(pathIsInFolder('')(normalize('/foo/bar'))).to.equal(false);
  });

  it('handles empty target path gracefully', () => {
    expect(pathIsInFolder(normalize('/foo/bar'))('')).to.equal(false);
  });

  it('handles both paths being empty', () => {
    expect(pathIsInFolder('')('')).to.equal(false);
  });

  it('handles paths with trailing slashes', () => {
    expect(pathIsInFolder(normalize('/foo/bar/'))(normalize('/foo/bar/baz'))).to.equal(true);
    expect(pathIsInFolder(normalize('/foo/bar/'))(normalize('/foo/bar'))).to.equal(true);
    expect(pathIsInFolder(normalize('/foo/bar/'))(normalize('/foo/bar/baz/'))).to.equal(true);
    expect(pathIsInFolder(normalize('/foo/bar/'))(normalize('/foo/bar/'))).to.equal(true);
  });

  it('handles paths with mixed separators', () => {
    expect(pathIsInFolder(normalize('/foo\\bar'))(normalize('/foo/bar/baz'))).to.equal(true);
  });

  it('handles exact paths', () => {
    expect(pathIsInFolder(normalize('/foo/bar'))(normalize('/foo/bar'))).to.equal(true);
  });
});
