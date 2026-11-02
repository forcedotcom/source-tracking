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

import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { Lifecycle } from '@salesforce/core';

const DEFAULT_FD_PERMITS = process.platform === 'win32' ? 64 : 256;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 600;
const DEFAULT_LOCK_AUTOCLEAR_SECONDS = 300;
const SOURCE_MEMBER_POLLING_INTERVAL_MS = 1000;
const DEFAULT_EMPTY_POLLING_RESULT_LIMIT = 120;

const sourceMemberPollingSettings = (
  timeoutSeconds?: number
): Pick<
  SourceTrackingSettings,
  'sourceMemberPollingTimeout' | 'sourceMemberPollingIntervalMs' | 'sourceMemberPollingEmptyResultLimit'
> => ({
  sourceMemberPollingIntervalMs: SOURCE_MEMBER_POLLING_INTERVAL_MS,
  sourceMemberPollingEmptyResultLimit:
    timeoutSeconds === undefined
      ? DEFAULT_EMPTY_POLLING_RESULT_LIMIT
      : timeoutSeconds / (SOURCE_MEMBER_POLLING_INTERVAL_MS / 1000),
  sourceMemberPollingTimeout:
    timeoutSeconds === undefined
      ? (memberCount: number): Duration.Duration => Duration.seconds(Math.ceil(memberCount * 0.05) + 5)
      : (): Duration.Duration => Duration.seconds(timeoutSeconds),
});

export type SourceTrackingSettings = {
  readonly fdPermits: number;
  readonly disableSourceMobility: boolean;
  readonly assumeSynced: boolean;
  readonly lockTimeoutSeconds: number;
  readonly lockAutoclearSeconds: number;
  readonly disableSourceMemberPolling: boolean;
  readonly sourceMemberPollingTimeout: (memberCount: number) => Duration.Duration;
  readonly sourceMemberPollingIntervalMs: number;
  readonly sourceMemberPollingEmptyResultLimit: number;
  readonly fileVersion: number;
  readonly integrityCheck: boolean;
};

export const DEFAULT_SOURCE_TRACKING_SETTINGS: SourceTrackingSettings = {
  fdPermits: DEFAULT_FD_PERMITS,
  disableSourceMobility: false,
  assumeSynced: false,
  lockTimeoutSeconds: DEFAULT_LOCK_TIMEOUT_SECONDS,
  lockAutoclearSeconds: DEFAULT_LOCK_AUTOCLEAR_SECONDS,
  disableSourceMemberPolling: false,
  ...sourceMemberPollingSettings(),
  fileVersion: 0,
  integrityCheck: false,
};

export const SourceTrackingConfig = Context.Reference<SourceTrackingSettings>('@salesforce/source-tracking/config', {
  defaultValue: () => DEFAULT_SOURCE_TRACKING_SETTINGS,
});

const positiveNumber = (name: string): Config.Config<number> =>
  Config.schema(Schema.Finite.check(Schema.isGreaterThan(0)), name);
const positiveInteger = (name: string): Config.Config<number> =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name);
const natural = (name: string): Config.Config<number> => Config.schema(Schema.Natural, name);
const decodeBoolean = Schema.decodeUnknownEffect(Schema.Literals(['true', 'false', '1', '0']));
const kitBoolean = (name: string): Config.Config<boolean> =>
  Config.String(name).pipe(
    Config.mapEffect((raw) =>
      decodeBoolean(raw.toLowerCase()).pipe(
        Effect.map((value) => value === 'true' || value === '1'),
        Effect.mapError((cause) => new Config.ConfigError(cause))
      )
    )
  );

const emitConfigWarning = Effect.fnUntraced(function* (warning: string) {
  yield* Effect.tryPromise({
    try: () => Lifecycle.getInstance().emitWarning(warning),
    catch: () => undefined,
  }).pipe(Effect.ignore);
});

const setting = <A>(name: string, makeConfig: (name: string) => Config.Config<A>, fallback: A): Config.Config<A> =>
  makeConfig(name).pipe(
    Config.withDefault(fallback),
    Config.orElse((error) =>
      Schema.isSchemaError(error.cause)
        ? Config.succeed(fallback).pipe(
            Config.mapEffect(() =>
              emitConfigWarning(`${name} is invalid; using ${String(fallback)}`).pipe(Effect.as(fallback))
            )
          )
        : Config.fail(error.cause)
    )
  );

// Choose aliases before validation: an invalid canonical value must not enable a legacy override.
const aliasedSetting = <A>(
  name: string,
  alias: string,
  makeConfig: (name: string) => Config.Config<A>,
  fallback: A
): Config.Config<A> =>
  Config.all({
    value: Config.option(Config.String(name)),
    legacyValue: Config.option(Config.String(alias)),
  }).pipe(
    Config.flatMap(({ value, legacyValue }) => {
      if (Option.isSome(value) || Option.isNone(legacyValue)) return setting(name, makeConfig, fallback);
      return setting(alias, makeConfig, fallback).pipe(
        Config.mapEffect((decoded) =>
          emitConfigWarning(`${alias} is deprecated; use ${name}.`).pipe(Effect.as(decoded))
        )
      );
    })
  );

const fdPermitsConfig = Config.all({
  canonical: Config.option(Config.String('SF_SOURCE_TRACKING_FD_PERMITS')),
  batchSize: Config.option(Config.String('SF_SOURCE_TRACKING_BATCH_SIZE')),
  legacyBatchSize: Config.option(Config.String('SFDX_SOURCE_TRACKING_BATCH_SIZE')),
}).pipe(
  Config.flatMap(({ canonical, batchSize, legacyBatchSize }) => {
    const alias = Option.isSome(batchSize) ? 'SF_SOURCE_TRACKING_BATCH_SIZE' : 'SFDX_SOURCE_TRACKING_BATCH_SIZE';
    if (Option.isSome(canonical)) {
      return setting('SF_SOURCE_TRACKING_FD_PERMITS', positiveInteger, DEFAULT_FD_PERMITS).pipe(
        Config.mapEffect((value) =>
          Option.isSome(batchSize) || Option.isSome(legacyBatchSize)
            ? emitConfigWarning(`${alias} is ignored because SF_SOURCE_TRACKING_FD_PERMITS is set.`).pipe(
                Effect.as(value)
              )
            : Effect.succeed(value)
        )
      );
    }
    if (Option.isNone(batchSize) && Option.isNone(legacyBatchSize)) return Config.succeed(DEFAULT_FD_PERMITS);
    return setting(alias, positiveInteger, DEFAULT_FD_PERMITS).pipe(
      Config.map((value) => Math.min(value, DEFAULT_FD_PERMITS)),
      Config.mapEffect((value) =>
        emitConfigWarning(`${alias} is deprecated; use SF_SOURCE_TRACKING_FD_PERMITS.`).pipe(Effect.as(value))
      )
    );
  })
);

const settingsConfig = Config.all({
  fdPermits: fdPermitsConfig,
  disableSourceMobility: setting('SF_DISABLE_SOURCE_MOBILITY', kitBoolean, false),
  assumeSynced: setting('SF_SOURCE_TRACKING_ASSUME_SYNCED', kitBoolean, false),
  lockTimeoutSeconds: setting('SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS', positiveNumber, DEFAULT_LOCK_TIMEOUT_SECONDS),
  lockAutoclearSeconds: setting(
    'SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS',
    positiveNumber,
    DEFAULT_LOCK_AUTOCLEAR_SECONDS
  ),
  disableSourceMemberPolling: aliasedSetting(
    'SF_DISABLE_SOURCE_MEMBER_POLLING',
    'SFDX_DISABLE_SOURCE_MEMBER_POLLING',
    kitBoolean,
    false
  ),
  sourceMemberPollingTimeout: aliasedSetting<number | undefined>(
    'SF_SOURCE_MEMBER_POLLING_TIMEOUT',
    'SFDX_SOURCE_MEMBER_POLLING_TIMEOUT',
    positiveNumber,
    undefined
  ),
  fileVersion: setting('SF_SOURCE_TRACKING_FILE_VERSION', natural, 0),
  integrityCheck: setting('SF_SOURCE_TRACKING_INTEGRITY_CHECK', kitBoolean, false),
}).pipe(
  Config.map(({ sourceMemberPollingTimeout, ...settings }) => ({
    ...settings,
    ...sourceMemberPollingSettings(sourceMemberPollingTimeout),
  }))
);

export const loadSourceTrackingSettings = (
  provider: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv()
): Effect.Effect<SourceTrackingSettings, Config.ConfigError> => settingsConfig.parse(provider);

export type SourceTrackingRuntime = ManagedRuntime.ManagedRuntime<never, Config.ConfigError>;

/** Create an isolated config runtime. Tests can inject a ConfigProvider here. */
export const makeSourceTrackingRuntime = (
  provider: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv()
): SourceTrackingRuntime =>
  ManagedRuntime.make(
    provider.pipe(ConfigProvider.layer, Layer.provideMerge(sourceTrackingConfigLayerFromProvider(provider)))
  );

let processRuntime: SourceTrackingRuntime | undefined;

/** Resolve the one process-wide runtime and its immutable environment snapshot. */
export const getProcessSourceTrackingRuntime = (): SourceTrackingRuntime =>
  (processRuntime ??= makeSourceTrackingRuntime());

export const getProcessSourceTrackingSettings = (): Promise<SourceTrackingSettings> =>
  getProcessSourceTrackingRuntime().runPromise(SourceTrackingConfig);

export const sourceTrackingConfigLayer = (settings: SourceTrackingSettings): Layer.Layer<never, never, never> =>
  Layer.succeed(SourceTrackingConfig, settings);

export const sourceTrackingConfigLayerFromProvider = (
  provider: ConfigProvider.ConfigProvider
): Layer.Layer<never, Config.ConfigError, never> =>
  Layer.effect(SourceTrackingConfig, loadSourceTrackingSettings(provider));

export const runWithProcessSourceTrackingRuntime = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  getProcessSourceTrackingRuntime().runPromise(effect);
