/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
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
