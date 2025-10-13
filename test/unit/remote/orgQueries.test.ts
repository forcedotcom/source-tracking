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
import { Logger, envVars } from '@salesforce/core';
import { expect } from 'chai';
import { calculateTimeout } from '../../../src/shared/remote/orgQueries.js';

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
