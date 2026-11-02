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
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

const DEFAULT_FD_PERMITS = process.platform === 'win32' ? 64 : 256;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 600;
const DEFAULT_LOCK_AUTOCLEAR_SECONDS = 300;

const RawConfig = Config.all({
  fdPermits: Config.option(Config.String('SF_SOURCE_TRACKING_FD_PERMITS')),
  batchSize: Config.option(Config.String('SF_SOURCE_TRACKING_BATCH_SIZE')),
  legacyBatchSize: Config.option(Config.String('SFDX_SOURCE_TRACKING_BATCH_SIZE')),
  disableSourceMobility: Config.option(Config.String('SF_DISABLE_SOURCE_MOBILITY')),
  assumeSynced: Config.option(Config.String('SF_SOURCE_TRACKING_ASSUME_SYNCED')),
  lockTimeoutSeconds: Config.option(Config.String('SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS')),
  lockAutoclearSeconds: Config.option(Config.String('SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS')),
  disableSourceMemberPolling: Config.option(Config.String('SF_DISABLE_SOURCE_MEMBER_POLLING')),
  legacyDisableSourceMemberPolling: Config.option(Config.String('SFDX_DISABLE_SOURCE_MEMBER_POLLING')),
  sourceMemberPollingTimeout: Config.option(Config.String('SF_SOURCE_MEMBER_POLLING_TIMEOUT')),
  legacySourceMemberPollingTimeout: Config.option(Config.String('SFDX_SOURCE_MEMBER_POLLING_TIMEOUT')),
  fileVersion: Config.option(Config.String('SF_SOURCE_TRACKING_FILE_VERSION')),
  integrityCheck: Config.option(Config.String('SF_SOURCE_TRACKING_INTEGRITY_CHECK')),
});

export type SourceTrackingSettings = {
  readonly fdPermits: number;
  readonly disableSourceMobility: boolean;
  readonly assumeSynced: boolean;
  readonly lockTimeoutSeconds: number;
  readonly lockAutoclearSeconds: number;
  readonly disableSourceMemberPolling: boolean;
  readonly sourceMemberPollingTimeout?: number;
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
  fileVersion: 0,
  integrityCheck: false,
};

export const SourceTrackingConfig = Context.Reference<SourceTrackingSettings>('@salesforce/source-tracking/config', {
  defaultValue: () => DEFAULT_SOURCE_TRACKING_SETTINGS,
});

const positiveNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const nonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const kitNumber = (raw: string): number =>
  // Kit's toNumber accepts JavaScript numeric forms (including hex and Infinity).
  // Empty strings are treated as missing by Env.getNumber.
  Number(raw);
const readNumber = <A>(
  name: string,
  value: Option.Option<string>,
  schema: Schema.ConstraintCodec<A, number>,
  fallback: A
): Effect.Effect<A> =>
  Option.match(value, {
    onNone: () => Effect.succeed(fallback),
    onSome: (raw) => {
      const parsed = raw === '' ? Number.NaN : kitNumber(raw);
      const decoded = Schema.decodeUnknownOption(schema)(parsed);
      return Option.match(decoded, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.logWarning(`${name}=${JSON.stringify(raw)} is invalid; using ${String(fallback)}`).pipe(
            Effect.as(fallback)
          ),
      });
    },
  });

const readOptionalNumber = (name: string, value: Option.Option<string>): Effect.Effect<number | undefined> =>
  Option.match(value, {
    onNone: () => Effect.sync(() => undefined),
    onSome: (raw) => {
      const parsed = raw === '' ? Number.NaN : kitNumber(raw);
      const decoded = Schema.decodeUnknownOption(positiveNumber)(parsed);
      return Option.match(decoded, {
        onSome: (seconds) => Effect.succeed(seconds),
        onNone: () =>
          Effect.logWarning(`${name}=${JSON.stringify(raw)} is invalid; ignoring it`).pipe(Effect.as(undefined)),
      });
    },
  });

const kitBoolean = (name: string, value: Option.Option<string>): Effect.Effect<boolean> =>
  Option.match(value, {
    onNone: () => Effect.succeed(false),
    onSome: (raw) => {
      const normalized = raw.toLowerCase();
      if (normalized === 'true' || raw === '1') return Effect.succeed(true);
      if (normalized === 'false' || raw === '0') return Effect.succeed(false);
      return Effect.logWarning(`${name}=${JSON.stringify(raw)} is invalid; using false`).pipe(Effect.as(false));
    },
  });

export const loadSourceTrackingSettings = (
  provider: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv()
): Effect.Effect<SourceTrackingSettings, Config.ConfigError> =>
  Effect.gen(function* () {
    const raw = yield* RawConfig.parse(provider);
    const disablePollingRaw = Option.orElse(raw.disableSourceMemberPolling, () => raw.legacyDisableSourceMemberPolling);
    const pollingTimeoutRaw = Option.orElse(raw.sourceMemberPollingTimeout, () => raw.legacySourceMemberPollingTimeout);
    if (Option.isNone(raw.disableSourceMemberPolling) && Option.isSome(raw.legacyDisableSourceMemberPolling)) {
      yield* Effect.logWarning(
        'SFDX_DISABLE_SOURCE_MEMBER_POLLING is deprecated; use SF_DISABLE_SOURCE_MEMBER_POLLING.'
      );
    }
    if (Option.isNone(raw.sourceMemberPollingTimeout) && Option.isSome(raw.legacySourceMemberPollingTimeout)) {
      yield* Effect.logWarning(
        'SFDX_SOURCE_MEMBER_POLLING_TIMEOUT is deprecated; use SF_SOURCE_MEMBER_POLLING_TIMEOUT.'
      );
    }
    const legacyBatchSize = Option.orElse(raw.batchSize, () => raw.legacyBatchSize);
    const legacyBatchName = Option.isSome(raw.batchSize)
      ? 'SF_SOURCE_TRACKING_BATCH_SIZE'
      : 'SFDX_SOURCE_TRACKING_BATCH_SIZE';
    const fdPermitsRaw = Option.isSome(raw.fdPermits) ? raw.fdPermits : legacyBatchSize;
    if (Option.isSome(fdPermitsRaw) && Option.isNone(raw.fdPermits)) {
      yield* Effect.logWarning(`${legacyBatchName} is deprecated; use SF_SOURCE_TRACKING_FD_PERMITS.`);
    }
    if (Option.isSome(raw.fdPermits) && Option.isSome(legacyBatchSize)) {
      yield* Effect.logWarning(`${legacyBatchName} is ignored because SF_SOURCE_TRACKING_FD_PERMITS is set.`);
    }
    const [
      rawFdPermits,
      lockTimeoutSeconds,
      lockAutoclearSeconds,
      sourceMemberPollingTimeout,
      fileVersion,
      disableSourceMobility,
      assumeSynced,
      disableSourceMemberPolling,
      integrityCheck,
    ] = yield* Effect.all([
      readNumber(
        Option.isSome(raw.fdPermits) ? 'SF_SOURCE_TRACKING_FD_PERMITS' : legacyBatchName,
        fdPermitsRaw,
        positiveInteger,
        DEFAULT_FD_PERMITS
      ),
      readNumber(
        'SF_SOURCE_TRACKING_LOCK_TIMEOUT_SECONDS',
        raw.lockTimeoutSeconds,
        positiveNumber,
        DEFAULT_LOCK_TIMEOUT_SECONDS
      ),
      readNumber(
        'SF_SOURCE_TRACKING_LOCK_AUTOCLEAR_SECONDS',
        raw.lockAutoclearSeconds,
        positiveNumber,
        DEFAULT_LOCK_AUTOCLEAR_SECONDS
      ),
      readOptionalNumber(
        Option.isSome(raw.sourceMemberPollingTimeout)
          ? 'SF_SOURCE_MEMBER_POLLING_TIMEOUT'
          : 'SFDX_SOURCE_MEMBER_POLLING_TIMEOUT',
        pollingTimeoutRaw
      ),
      readNumber('SF_SOURCE_TRACKING_FILE_VERSION', raw.fileVersion, nonNegativeInteger, 0),
      kitBoolean('SF_DISABLE_SOURCE_MOBILITY', raw.disableSourceMobility),
      kitBoolean('SF_SOURCE_TRACKING_ASSUME_SYNCED', raw.assumeSynced),
      kitBoolean(
        Option.isSome(raw.disableSourceMemberPolling)
          ? 'SF_DISABLE_SOURCE_MEMBER_POLLING'
          : 'SFDX_DISABLE_SOURCE_MEMBER_POLLING',
        disablePollingRaw
      ),
      kitBoolean('SF_SOURCE_TRACKING_INTEGRITY_CHECK', raw.integrityCheck),
    ]);
    // Prior batch-size values can exceed safe concurrent file descriptors by
    // orders of magnitude. Keep smaller explicit values as useful limits.
    const fdPermits = Option.isSome(raw.fdPermits)
      ? rawFdPermits
      : Option.isSome(fdPermitsRaw)
      ? Math.min(rawFdPermits, DEFAULT_FD_PERMITS)
      : rawFdPermits;

    return {
      fdPermits,
      disableSourceMobility,
      assumeSynced,
      lockTimeoutSeconds,
      lockAutoclearSeconds,
      disableSourceMemberPolling,
      ...(sourceMemberPollingTimeout === undefined ? {} : { sourceMemberPollingTimeout }),
      fileVersion,
      integrityCheck,
    } satisfies SourceTrackingSettings;
  });

let processSettings: Promise<SourceTrackingSettings> | undefined;

/** Resolve one immutable environment snapshot for this Node process. */
export const getProcessSourceTrackingSettings = (): Promise<SourceTrackingSettings> =>
  (processSettings ??= Effect.runPromise(loadSourceTrackingSettings().pipe(Effect.orDie)));

export const sourceTrackingConfigLayer = (settings: SourceTrackingSettings): Layer.Layer<never, never, never> =>
  Layer.succeed(SourceTrackingConfig, settings);

export const sourceTrackingConfigLayerFromProvider = (
  provider: ConfigProvider.ConfigProvider
): Layer.Layer<never, Config.ConfigError, never> =>
  Layer.effect(SourceTrackingConfig, loadSourceTrackingSettings(provider));

/** Run Effect code with the process-wide settings snapshot; tests may provide a different service directly. */
export const provideProcessSourceTrackingConfig = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  effect.pipe(Effect.provideServiceEffect(SourceTrackingConfig, Effect.promise(getProcessSourceTrackingSettings)));

export const runWithProcessSourceTrackingConfig = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  provideProcessSourceTrackingConfig(effect).pipe(Effect.orDie, Effect.runPromise);
