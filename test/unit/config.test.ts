/*
 * Copyright 2026, Salesforce, Inc.
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
import { Lifecycle } from '@salesforce/core';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import sinon from 'sinon';
import { loadSourceTrackingSettings, makeSourceTrackingRuntime, SourceTrackingConfig } from '../../src/config.js';

describe('source tracking config', () => {
  afterEach(() => sinon.restore());

  it('provides one injected config snapshot through a reusable runtime', async () => {
    const runtime = makeSourceTrackingRuntime(
      ConfigProvider.fromEnvRecord({ SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS: '12' })
    );
    try {
      const [first, second] = await Promise.all([
        runtime.runPromise(SourceTrackingConfig),
        runtime.runPromise(SourceTrackingConfig),
      ]);

      expect(first).to.equal(second);
      expect(first.lockTimeoutSeconds).to.equal(12);
    } finally {
      await runtime.dispose();
    }
  });

  it('uses defaults and Kit-compatible boolean parsing', async () => {
    const warnings: string[] = [];
    sinon.stub(Lifecycle.getInstance(), 'emitWarning').callsFake(async (warning) => void warnings.push(warning));
    const provider = ConfigProvider.fromEnvRecord({
      SF_DISABLE_SOURCE_MOBILITY: 'TrUe',
      SF_SOURCE_TRACKING_ASSUME_SYNCED: '1',
      SF_DISABLE_SOURCE_MEMBER_POLLING: 'yes',
      SF_SOURCE_TRACKING_INTEGRITY_CHECK: 'TRUE',
    });
    const settings = await loadSourceTrackingSettings(provider).pipe(Effect.runPromise);

    expect(settings).to.include({
      disableSourceMobility: true,
      assumeSynced: true,
      disableSourceMemberPolling: false,
      integrityCheck: true,
      fileVersion: 0,
      lockTimeoutSeconds: 600,
    });
    expect(warnings).to.deep.equal(['SF_DISABLE_SOURCE_MEMBER_POLLING="yes" is invalid; using false']);
  });

  it('uses validated aliases and warns on deprecated batch-size variables', async () => {
    const warnings: string[] = [];
    sinon.stub(Lifecycle.getInstance(), 'emitWarning').callsFake(async (warning) => void warnings.push(warning));
    const settings = await loadSourceTrackingSettings(
      ConfigProvider.fromEnvRecord({ SFDX_SOURCE_TRACKING_BATCH_SIZE: '2000' })
    ).pipe(Effect.runPromise);

    expect(settings.fdPermits).to.equal(process.platform === 'win32' ? 64 : 256);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.contain('SFDX_SOURCE_TRACKING_BATCH_SIZE is deprecated');
  });

  it('warns and falls back on invalid values; canonical batch config wins', async () => {
    const warnings: string[] = [];
    sinon.stub(Lifecycle.getInstance(), 'emitWarning').callsFake(async (warning) => void warnings.push(warning));
    const provider = ConfigProvider.fromEnvRecord({
      SF_SOURCE_TRACKING_FD_PERMITS: '0',
      SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS: 'NaN',
      SF_SOURCE_TRACKING_BATCH_SIZE: '100',
      SFDX_SOURCE_TRACKING_BATCH_SIZE: '200',
      SF_SOURCE_TRACKING_FILE_VERSION: '-1',
    });
    const settings = await loadSourceTrackingSettings(provider).pipe(Effect.runPromise);

    expect(settings).to.include({ fdPermits: process.platform === 'win32' ? 64 : 256, lockTimeoutSeconds: 600 });
    expect(warnings).to.have.length(4);
    expect(warnings.join('\n')).to.contain('SF_SOURCE_TRACKING_BATCH_SIZE is ignored');
  });
});
