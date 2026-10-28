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
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { Org, SfProject } from '@salesforce/core';
import { SourceTracking } from '../../src/sourceTracking';

const projectPath = process.env.STL_STATUS_PROFILE_PROJECT_PATH;
const orgAliasOrUsername = process.env.STL_STATUS_PROFILE_ORG;
if (!projectPath || !orgAliasOrUsername) {
  throw new Error('STL_STATUS_PROFILE_PROJECT_PATH and STL_STATUS_PROFILE_ORG are required');
}

type Measurement = { calls: number; durationMs: number };
type PrivateSourceTracking = SourceTracking & Record<string, unknown>;
const milliseconds = (duration: bigint): number => Number(duration) / 1_000_000;

const profile = (tracking: PrivateSourceTracking, methodName: string, measurement: Measurement): void => {
  const original = tracking[methodName];
  if (typeof original !== 'function') throw new Error(`Expected SourceTracking.${methodName} to be a function`);
  const operation = original as (...args: unknown[]) => Promise<unknown>;
  tracking[methodName] = async (...args: unknown[]) => {
    const startedAt = process.hrtime.bigint();
    try {
      return await operation.apply(tracking, args);
    } finally {
      measurement.calls += 1;
      measurement.durationMs += milliseconds(process.hrtime.bigint() - startedAt);
    }
  };
};

const main = async (): Promise<void> => {
  const [org, project] = await Promise.all([
    Org.create({ aliasOrUsername: orgAliasOrUsername }),
    SfProject.resolve(projectPath),
  ]);
  const tracking = (await SourceTracking.create({ org, project })) as PrivateSourceTracking;
  const measurements: Record<string, Measurement> = {
    localRows: { calls: 0, durationMs: 0 },
    ensureRemoteTracking: { calls: 0, durationMs: 0 },
    remoteChanges: { calls: 0, durationMs: 0 },
    remoteRows: { calls: 0, durationMs: 0 },
    conflicts: { calls: 0, durationMs: 0 },
  };
  profile(tracking, 'getLocalStatusRows', measurements.localRows);
  profile(tracking, 'ensureRemoteTracking', measurements.ensureRemoteTracking);
  profile(tracking, 'remoteChangesToOutputRows', measurements.remoteRows);
  profile(tracking, 'getConflicts', measurements.conflicts);

  const originalGetChanges = tracking.getChanges.bind(tracking);
  tracking.getChanges = (async (options: { origin?: string }) => {
    const startedAt = process.hrtime.bigint();
    try {
      return await originalGetChanges(options as never);
    } finally {
      if (options.origin === 'remote') {
        measurements.remoteChanges.calls += 1;
        measurements.remoteChanges.durationMs += milliseconds(process.hrtime.bigint() - startedAt);
      }
    }
  }) as unknown as SourceTracking['getChanges'];

  await Promise.all([tracking.reReadLocalTrackingCache(), tracking.reReadRemoteTracking()]);
  const startedAt = process.hrtime.bigint();
  const status = await tracking.getStatus({ local: true, remote: true });
  const getStatusMs = milliseconds(process.hrtime.bigint() - startedAt);

  process.stdout.write(
    `${JSON.stringify({
      name: 'status-profile',
      projectPath,
      orgId: org.getOrgId(),
      statusRows: status.length,
      statusDigest: createHash('sha256').update(JSON.stringify(status)).digest('hex'),
      getStatusMs,
      phases: measurements,
    })}${os.EOL}`
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}${os.EOL}`);
  process.exitCode = 1;
});
