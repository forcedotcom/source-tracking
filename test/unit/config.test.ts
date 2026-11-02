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
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import sinon from 'sinon';
import {
  DEFAULT_SOURCE_TRACKING_SETTINGS,
  loadSourceTrackingSettings,
  makeSourceTrackingRuntime,
  SourceTrackingConfig,
} from '../../src/config.js';

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

  it('uses Effect boolean literals and warns on invalid values', async () => {
    const warnings: string[] = [];
    sinon.stub(Lifecycle.getInstance(), 'emitWarning').callsFake(async (warning) => void warnings.push(warning));
    const provider = ConfigProvider.fromEnvRecord({
      SF_DISABLE_SOURCE_MOBILITY: 'yes',
      SF_SOURCE_TRACKING_ASSUME_SYNCED: '1',
      SF_DISABLE_SOURCE_MEMBER_POLLING: 'on',
      SF_SOURCE_TRACKING_INTEGRITY_CHECK: 'TRUE',
    });
    const settings = await loadSourceTrackingSettings(provider).pipe(Effect.runPromise);

    expect(settings).to.include({
      disableSourceMobility: true,
      assumeSynced: true,
      disableSourceMemberPolling: true,
      integrityCheck: false,
      fileVersion: 0,
      lockTimeoutSeconds: 600,
    });
    expect(warnings).to.deep.equal(['SF_SOURCE_TRACKING_INTEGRITY_CHECK is invalid; using false']);
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

  it('uses defaults for unsupported numeric forms', async () => {
    const warnings: string[] = [];
    sinon.stub(Lifecycle.getInstance(), 'emitWarning').callsFake(async (warning) => void warnings.push(warning));
    const settings = await loadSourceTrackingSettings(
      ConfigProvider.fromEnvRecord(
        {
          SF_SOURCE_TRACKING_FD_PERMITS: '0x10',
          SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS: 'Infinity',
          SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS: 'NaN',
          SF_SOURCE_TRACKING_FILE_VERSION: '',
          SF_SOURCE_MEMBER_POLLING_TIMEOUT: '',
        },
        { preserveEmptyStrings: true }
      )
    ).pipe(Effect.runPromise);

    expect(settings).to.include({
      fdPermits: process.platform === 'win32' ? 64 : 256,
      lockTimeoutSeconds: 600,
      lockAutoclearSeconds: 300,
      fileVersion: 0,
    });
    expect(Duration.toSeconds(settings.sourceMemberPollingTimeout(10_000))).to.equal(505);
    expect(settings.sourceMemberPollingEmptyResultLimit).to.equal(120);
    expect(warnings).to.have.length(5);
  });

  it('resolves all polling defaults without an override', async () => {
    const settings = await ConfigProvider.fromEnvRecord({}).pipe(loadSourceTrackingSettings, Effect.runPromise);
    for (const config of [settings, DEFAULT_SOURCE_TRACKING_SETTINGS]) {
      expect(config.sourceMemberPollingIntervalMs).to.equal(1000);
      expect(config.sourceMemberPollingEmptyResultLimit).to.equal(120);
      expect(Duration.toSeconds(config.sourceMemberPollingTimeout(0))).to.equal(5);
      expect(Duration.toSeconds(config.sourceMemberPollingTimeout(10_000))).to.equal(505);
    }
  });

  for (const name of ['SF_SOURCE_MEMBER_POLLING_TIMEOUT', 'SFDX_SOURCE_MEMBER_POLLING_TIMEOUT']) {
    it(`resolves the timeout and empty-result limit from ${name}`, async () => {
      const warning = sinon.stub(Lifecycle.getInstance(), 'emitWarning').resolves();
      const settings = await ConfigProvider.fromEnvRecord({ [name]: '2.5' }).pipe(
        loadSourceTrackingSettings,
        Effect.runPromise
      );
      expect(Duration.toSeconds(settings.sourceMemberPollingTimeout(0))).to.equal(2.5);
      expect(Duration.toSeconds(settings.sourceMemberPollingTimeout(10_000))).to.equal(2.5);
      expect(settings.sourceMemberPollingEmptyResultLimit).to.equal(2.5);
      expect(warning.callCount).to.equal(name.startsWith('SFDX') ? 1 : 0);
    });
  }

  it('keeps an invalid canonical timeout from enabling a legacy override', async () => {
    const warning = sinon.stub(Lifecycle.getInstance(), 'emitWarning').resolves();
    const settings = await ConfigProvider.fromEnvRecord({
      SF_SOURCE_MEMBER_POLLING_TIMEOUT: 'NaN',
      SFDX_SOURCE_MEMBER_POLLING_TIMEOUT: '10',
    }).pipe(loadSourceTrackingSettings, Effect.runPromise);
    expect(Duration.toSeconds(settings.sourceMemberPollingTimeout(10_000))).to.equal(505);
    expect(settings.sourceMemberPollingEmptyResultLimit).to.equal(120);
    expect(warning.callCount).to.equal(1);
  });

  for (const value of ['Infinity', 'NaN', '0x10', '']) {
    it(`defaults every numeric setting for ${JSON.stringify(value)}`, async () => {
      sinon.stub(Lifecycle.getInstance(), 'emitWarning').resolves();
      const settings = await ConfigProvider.fromEnvRecord({
        SF_SOURCE_TRACKING_FD_PERMITS: value,
        SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS: value,
        SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS: value,
        SF_SOURCE_TRACKING_FILE_VERSION: value,
        SF_SOURCE_MEMBER_POLLING_TIMEOUT: value,
      }).pipe(loadSourceTrackingSettings, Effect.runPromise);
      expect(settings).to.include({
        fdPermits: DEFAULT_SOURCE_TRACKING_SETTINGS.fdPermits,
        lockTimeoutSeconds: 600,
        lockAutoclearSeconds: 300,
        fileVersion: 0,
        sourceMemberPollingEmptyResultLimit: 120,
      });
      expect(Duration.toSeconds(settings.sourceMemberPollingTimeout(10_000))).to.equal(505);
    });
  }

  it('retains positive fractional timeouts, integer counts, and false booleans', async () => {
    const warning = sinon.stub(Lifecycle.getInstance(), 'emitWarning').resolves();
    const settings = await ConfigProvider.fromEnvRecord({
      SF_SOURCE_TRACKING_FD_PERMITS: '10',
      SF_SOURCE_TRACKING_FILE_VERSION: '2',
      SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS: '1.5',
      SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS: '2.5',
      SF_DISABLE_SOURCE_MOBILITY: 'false',
      SF_SOURCE_TRACKING_ASSUME_SYNCED: '0',
    }).pipe(loadSourceTrackingSettings, Effect.runPromise);
    expect(settings).to.include({
      fdPermits: 10,
      fileVersion: 2,
      lockTimeoutSeconds: 1.5,
      lockAutoclearSeconds: 2.5,
      disableSourceMobility: false,
      assumeSynced: false,
    });
    expect(warning.called).to.equal(false);
  });

  it('does not replace provider failures with defaults', async () => {
    const warning = sinon.stub(Lifecycle.getInstance(), 'emitWarning').resolves();
    const provider = ConfigProvider.make(() => Effect.fail(new ConfigProvider.SourceError({ message: 'unavailable' })));
    const result = await provider.pipe(loadSourceTrackingSettings, Effect.runPromiseExit);
    expect(Exit.isFailure(result)).to.equal(true);
    expect(warning.called).to.equal(false);
  });
});
