/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

describe('forceignore changes', () => {
  before(() => {
    // source status to init tracking
  });

  it.skip('will not push a file that was created, then ignored', () => {
    // add a file in the local source
    // setup a forceIgnore with some file
    // push
    // verify not in results
  });

  it.skip('will not push a file that was created, then un-ignored', () => {
    // setup a forceIgnore with some file
    // add a file in the local source
    // unignore the file
    // push
    // verify file pushed in results
  });

  it.skip('will not pull a remote file added to the ignore AFTER it is being tracked', () => {
    // make a remote change
    // add that type to the forceignore
    // pull doesn't retrieve that change
  });
});
