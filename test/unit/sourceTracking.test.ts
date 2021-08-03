/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as sinon from 'sinon';

describe('SourceTracking', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => {
    sandbox.restore();
  });

  describe('getChanges', () => {
    it('should get local changes');
    it('should get remote changes');
  });

  describe('update', () => {
    it('should update local changes');
    it('should update remote changes');
  });
});
