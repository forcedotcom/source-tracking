/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
describe('end-to-end-test for tracking with an org (single packageDir)', () => {
  describe('basic status and pull', () => {
    it('detects the initial metadata status');
    it('pushes the initial metadata to the org');
    it('sees no local changes, but remote change in profile');
    it('sees a local delete in status');
    it('does not see any change in remote status');
    it('pushes the local delete to the org');
    it('sees no local changes, but remote change in profile');
  });

  describe('conflict detection and resolution', () => {
    it('creates a conflict between local and remote');
    it('can see the conflict in status');
    it('gets conflict error on push');
    it('gets conflict error on pull');
    it('can push with forceoverride');
  });

  describe('remote changes', () => {
    describe('remote changes: delete', () => {
      it('deletes on the server');
      it('can see the delete in status');
      it('does not see any change in local status');
      it('can pull the delete');
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

  describe('non-successes', () => {
    it('should throw an err when attempting to pull from a non scratch-org');
    it('should not poll for SourceMembers when SFDX_DISABLE_SOURCE_MEMBER_POLLING=true');

    describe('push partial success', () => {
      it('can deploy source with some failures and show correct exit code');
      it('can see failures remaining in local tracking, but successes are gone');
    });

    describe('push failures', () => {
      it('handles failed push');
      it('has no changes to local tracking');
    });
  });

  describe('metadata type specific tracking', () => {
    describe('lwc', () => {
      it('sees lwc css changes in local status');
      it('pushes lwc css change');
      it("Deleting an lwc sub-component should show the sub-component as 'Deleted'");
      it('pushes lwc subcomponent delete');
      it('Each change to an lwc subcomponent should be expressed in its own line');
      it('bundle shows as changed?');
      it('detects remote subcomponent conflicts');
    });

    describe('aura', () => {
      it('sees aura css changes in local status');
      it('pushes aura css change');
      it("Deleting an aura sub-component should show the sub-component as 'Deleted'");
      it('pushes aura subcomponent delete');
      it('Each change to an aura subcomponent should be expressed in its own line');
      it('bundle shows as changed?');
      it('detects remote subcomponent conflicts');
    });
  });

  describe('forceignore changes', () => {
    it('will push a file created as ignored but then un-ignored');
    it('will not retrieve a remote file added to the ignore AFTER it is being tracked');
  });

  describe('something about hooks', () => {
    it('fires hooks from push');
    it('fires hooks from pull');
  });
});
