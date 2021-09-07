/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
describe('remote changes', () => {
  describe('remote changes: delete', () => {
    it('deletes on the server');
    it('can see the delete in status');
    it('does not see any change in local status');
    it('can pull the delete');
    it('local file was deleted');
    it('sees correct local and remote status');
  });
  describe('remote changes: change', () => {
    it('change on the server');
    it('can see the change in status');
    it('can pull the change');
    it('sees correct local and remote status');
  });

  describe('remote changes: add', () => {
    it('adds on the server');
    it('can see the add in status');
    it('can pull the add');
    it('sees correct local and remote status');
  });

  describe('remote changes: mixed', () => {
    it('all three types of changes on the server');
    it('can see the changes in status');
    it('can pull the changes');
    it('sees correct local and remote status');
  });
});
