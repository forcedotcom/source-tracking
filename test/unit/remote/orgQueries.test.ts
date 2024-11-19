/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Logger, envVars } from '@salesforce/core';
import { expect } from 'chai';
import { calculateTimeout } from '../../../src/shared/remote/orgQueries';
/*
 * Copyright (c) 2023, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

const reResolveEnvVars = (): void => {
  /* eslint-disable @typescript-eslint/no-unsafe-call */
  // @ts-expect-error to force a re-resolve
  envVars.resolve();
  /* eslint-enable @typescript-eslint/no-unsafe-call */
};

describe('calculateTimeout', () => {
  const logger = new Logger({ useMemoryLogger: true, name: 'test' }).getRawLogger();
  const functionUnderTest = calculateTimeout(logger);
  afterEach(() => {
    envVars.unset('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT');
    envVars.unset('SF_SOURCE_MEMBER_POLLING_TIMEOUT');
  });
  it('0 members => 5 sec', () => {
    expect(functionUnderTest(0).seconds).to.equal(5);
  });
  it('10000 members => 505 sec', () => {
    expect(functionUnderTest(10_000).seconds).to.equal(505);
  });
  it('override 60 in env', () => {
    envVars.setString('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT', '60');
    reResolveEnvVars();
    expect(functionUnderTest(10_000).seconds).to.equal(60);
  });
  it('override 0 in env has no effect', () => {
    envVars.setString('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT', '0');
    reResolveEnvVars();
    expect(functionUnderTest(10_000).seconds).to.equal(505);
  });
});
