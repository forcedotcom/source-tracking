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

/*
 * Controlled RP profile: a moderate decomposed inventory and disjoint remote
 * batches isolate CPU and allocation hot paths in updateRemoteTracking().
 */

import { spawn } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import * as fs from 'node:fs';
import * as inspector from 'node:inspector';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Org, SfProject } from '@salesforce/core';
import { ComponentStatus } from '@salesforce/source-deploy-retrieve';
import { Clock, Effect, Schema } from 'effect';
import type { RemoteSyncInput } from '../../src/shared/types.js';
import { SourceTracking } from '../../src/sourceTracking.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKSPACE_ROOT = path.join(os.tmpdir(), 'stl-perf-rp-profile');
const API_VERSION = '68.0';
const DEFAULT_OBJECTS = 100;
const DEFAULT_FIELDS_PER_OBJECT = 50;
const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_BATCHES = 1;
const DEFAULT_VISIBILITY_POLL_MS = 1_000;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 120_000;
const DEPLOY_COMPONENT_LIMIT = 9_500;

type SourceMember = { readonly MemberName: string; readonly RevisionCounter: number };
type ProfiledBatch = { readonly expected: RemoteSyncInput[]; readonly project: string };

class ProcessExitError extends Schema.TaggedError<ProcessExitError>()('ProcessExitError', {
  command: Schema.String,
  code: Schema.Number,
}) {}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; received ${value}.`);
  return value;
};

const run = (command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): Promise<void> =>
  Effect.runPromise(
    Effect.callback<void, Error | ProcessExitError>((resume) => {
      const child = spawn(command, args, { ...options, stdio: 'inherit' });
      child.once('error', (error) => resume(Effect.fail(error)));
      child.once('exit', (code) =>
        resume(code === 0 ? Effect.void : Effect.fail(new ProcessExitError({ command, code: code ?? -1 })))
      );
    })
  );

const sleep = (milliseconds: number): Promise<void> => Effect.runPromise(Effect.sleep(milliseconds));
const objectName = (prefix: string, index: number): string => `${prefix}Object${String(index).padStart(3, '0')}__c`;
const fieldName = (index: number): string => `Field${String(index).padStart(3, '0')}__c`;
const fieldXml = (name: string, description: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>${name}</fullName>\n  <description>${description}</description>\n  <label>${name}</label>\n  <length>255</length>\n  <type>Text</type>\n</CustomField>\n`;
const objectXml = (): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n  <deploymentStatus>Deployed</deploymentStatus>\n  <label>Profile Object</label>\n  <nameField><label>Profile Object Name</label><type>Text</type></nameField>\n  <pluralLabel>Profile Objects</pluralLabel>\n  <sharingModel>ReadWrite</sharingModel>\n</CustomObject>\n';

const writeProject = (root: string): void =>
  fs.writeFileSync(
    path.join(root, 'sfdx-project.json'),
    `${JSON.stringify(
      { packageDirectories: [{ path: 'force-app', default: true }], namespace: '', sourceApiVersion: API_VERSION },
      null,
      2
    )}${os.EOL}`
  );

const expectedMemberQuery = (names: readonly string[]): string =>
  `SELECT MemberName, RevisionCounter FROM SourceMember WHERE MemberType = 'CustomField' AND MemberName IN (${names
    .map((name) => `'${name}'`)
    .join(', ')})`;

const revisionsByMember = async (org: Org, names: readonly string[]): Promise<Map<string, number>> => {
  const result = await org.getConnection().tooling.query<SourceMember>(expectedMemberQuery(names));
  return new Map(result.records.map((member) => [member.MemberName, member.RevisionCounter]));
};

const waitForUpdatedMembers = async (
  org: Org,
  baseline: ReadonlyMap<string, number>,
  pollMs: number,
  timeoutMs: number
): Promise<{ readonly visibilityMs: number; readonly polls: number }> => {
  const names = [...baseline.keys()];
  const start = process.hrtime.bigint();
  let polls = 0;
  /* eslint-disable no-await-in-loop */
  while (Number(process.hrtime.bigint() - start) / 1e6 < timeoutMs) {
    const observed = await revisionsByMember(org, names);
    polls += 1;
    if (names.every((name) => (observed.get(name) ?? 0) > (baseline.get(name) ?? Number.MAX_SAFE_INTEGER))) {
      return { visibilityMs: Number(process.hrtime.bigint() - start) / 1e6, polls };
    }
    await sleep(pollMs);
  }
  /* eslint-enable no-await-in-loop */
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${names.length} updated SourceMember revisions.`);
};

const deployBaseline = async (
  project: string,
  alias: string,
  objects: readonly string[],
  fieldsPerObject: number
): Promise<void> => {
  const objectsPerBatch = Math.max(1, Math.floor(DEPLOY_COMPONENT_LIMIT / (fieldsPerObject + 1)));
  /* eslint-disable no-await-in-loop */
  for (let start = 0; start < objects.length; start += objectsPerBatch) {
    const sourceDirs = objects
      .slice(start, start + objectsPerBatch)
      .map((object) => path.join('force-app', 'main', 'default', 'objects', object));
    await run(
      'sf',
      [
        'project',
        'deploy',
        'start',
        ...sourceDirs.flatMap((sourceDir) => ['--source-dir', sourceDir]),
        '--target-org',
        alias,
        '--test-level',
        'NoTestRun',
      ],
      { cwd: project }
    );
  }
  /* eslint-enable no-await-in-loop */
};

const post = (session: inspector.Session, method: string, params?: object): Promise<Record<string, unknown>> =>
  Effect.runPromise(
    Effect.callback<Record<string, unknown>, Error>((resume) => {
      session.post(method, params, (error, result) =>
        resume(error ? Effect.fail(error) : Effect.succeed((result ?? {}) as Record<string, unknown>))
      );
    })
  );

const profile = async <T>(
  outputDir: string,
  batch: number,
  operation: () => Promise<T>
): Promise<{ readonly result: T; readonly elapsedMs: number }> => {
  const session = new inspector.Session();
  session.connect();
  try {
    await post(session, 'Profiler.enable');
    await post(session, 'HeapProfiler.enable');
    await post(session, 'HeapProfiler.startSampling', { samplingInterval: 8_192 });
    await post(session, 'Profiler.start');
    const start = process.hrtime.bigint();
    const result = await operation();
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const cpu = await post(session, 'Profiler.stop');
    const heap = await post(session, 'HeapProfiler.stopSampling');
    fs.writeFileSync(
      path.join(outputDir, `batch-${String(batch).padStart(2, '0')}.cpuprofile`),
      JSON.stringify(cpu.profile)
    );
    fs.writeFileSync(
      path.join(outputDir, `batch-${String(batch).padStart(2, '0')}.heapprofile`),
      JSON.stringify(heap.profile)
    );
    return { result, elapsedMs };
  } finally {
    session.disconnect();
  }
};

const main = async (): Promise<void> => {
  const devHub = requireEnv('STL_DEV_HUB_ALIAS');
  const timestamp = await Effect.runPromise(Clock.currentTimeMillis);
  const prefix = process.env.STL_FIXTURE_PREFIX ?? `StlProfile${timestamp}`;
  const alias = process.env.STL_PROFILE_SCRATCH_ALIAS ?? `stl-perf-profile-${timestamp}`;
  const objects = positiveInteger('STL_PROFILE_OBJECTS', DEFAULT_OBJECTS);
  const fieldsPerObject = positiveInteger('STL_PROFILE_FIELDS_PER_OBJECT', DEFAULT_FIELDS_PER_OBJECT);
  const batchSize = positiveInteger('STL_PROFILE_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const batches = positiveInteger('STL_PROFILE_BATCHES', DEFAULT_BATCHES);
  const visibilityPollMs = positiveInteger('STL_PROFILE_VISIBILITY_POLL_MS', DEFAULT_VISIBILITY_POLL_MS);
  const visibilityTimeoutMs = positiveInteger('STL_PROFILE_VISIBILITY_TIMEOUT_MS', DEFAULT_VISIBILITY_TIMEOUT_MS);
  const inventoryFields = objects * fieldsPerObject;
  if (batchSize * batches > inventoryFields)
    throw new Error(`Profiled fields (${batchSize * batches}) exceed baseline inventory (${inventoryFields}).`);

  const workspace = path.join(WORKSPACE_ROOT, prefix);
  const localProject = path.join(workspace, 'local');
  const outputDir = process.env.STL_PROFILE_OUTPUT_DIR ?? path.join(os.homedir(), 'stl-perf', 'profiles', prefix);
  const localObjects = path.join(localProject, 'force-app', 'main', 'default', 'objects');
  const objectNames: string[] = [];
  const profileBatches: ProfiledBatch[] = Array.from({ length: batches }, () => ({ expected: [], project: '' }));
  fs.mkdirSync(localObjects, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  writeProject(localProject);

  let changed = 0;
  for (let objectIndex = 0; objectIndex < objects; objectIndex++) {
    const object = objectName(prefix, objectIndex);
    objectNames.push(object);
    const fields = path.join(localObjects, object, 'fields');
    fs.mkdirSync(fields, { recursive: true });
    fs.writeFileSync(path.join(localObjects, object, `${object}.object-meta.xml`), objectXml());
    for (let fieldIndex = 0; fieldIndex < fieldsPerObject; fieldIndex++) {
      const field = fieldName(fieldIndex);
      const filename = `${field}.field-meta.xml`;
      fs.writeFileSync(path.join(fields, filename), fieldXml(field, 'profile baseline'));
      if (changed < batchSize * batches) {
        const batch = Math.floor(changed / batchSize);
        const project = path.join(workspace, `remote-batch-${String(batch).padStart(2, '0')}`);
        const remoteFields = path.join(project, 'force-app', 'main', 'default', 'objects', object, 'fields');
        fs.mkdirSync(remoteFields, { recursive: true });
        if (!fs.existsSync(path.join(project, 'sfdx-project.json'))) writeProject(project);
        fs.writeFileSync(path.join(remoteFields, filename), fieldXml(field, `profile batch ${batch}`));
        profileBatches[batch] = {
          expected: [
            ...profileBatches[batch].expected,
            {
              type: 'CustomField',
              fullName: `${object}.${field}`,
              filePath: path.join('force-app', 'main', 'default', 'objects', object, 'fields', filename),
              state: ComponentStatus.Changed,
            },
          ],
          project,
        };
        changed += 1;
      }
    }
  }

  try {
    await run('sf', [
      'org',
      'create',
      'scratch',
      '--definition-file',
      path.join(ROOT, 'config', 'perf-scratch-def.json'),
      '--target-dev-hub',
      devHub,
      '--alias',
      alias,
      '--duration-days',
      '1',
      '--wait',
      '20',
    ]);
    await deployBaseline(localProject, alias, objectNames, fieldsPerObject);
    const [org, project] = await Promise.all([Org.create({ aliasOrUsername: alias }), SfProject.resolve(localProject)]);
    const tracking = await SourceTracking.create({ org, project });
    await tracking.resetRemoteTracking();
    const summary: string[] = [
      `# RP profile run`,
      '',
      `- **orgId**: ${org.getOrgId()}`,
      `- **fixture**: ${objects} objects x ${fieldsPerObject} fields`,
      `- **profiledBatches**: ${batches} x ${batchSize} fields`,
      `- **profiles**: ${outputDir}`,
      '',
      '| batch | visibility ms/polls | reconciliation ms | outstanding |',
      '| ---: | --- | ---: | ---: |',
    ];
    /* eslint-disable no-await-in-loop */
    for (let batch = 0; batch < profileBatches.length; batch++) {
      const fixture = profileBatches[batch];
      const baseline = await revisionsByMember(
        org,
        fixture.expected.map(({ fullName }) => fullName)
      );
      if (baseline.size !== fixture.expected.length)
        throw new Error(
          `Batch ${batch} expected ${fixture.expected.length} baseline SourceMembers; found ${baseline.size}.`
        );
      await run(
        'sf',
        [
          'project',
          'deploy',
          'start',
          '--source-dir',
          'force-app/main/default/objects',
          '--target-org',
          alias,
          '--test-level',
          'NoTestRun',
          '--ignore-conflicts',
        ],
        { cwd: fixture.project }
      );
      const visibility = await waitForUpdatedMembers(org, baseline, visibilityPollMs, visibilityTimeoutMs);
      const timed = await profile(outputDir, batch, async () => tracking.updateRemoteTracking(fixture.expected));
      const outstanding = await tracking.getChanges({ origin: 'remote', state: 'nondelete', format: 'string' });
      if (outstanding.length !== 0)
        throw new Error(`Batch ${batch} left ${outstanding.length} outstanding remote changes.`);
      summary.push(
        `| ${batch} | ${Math.round(visibility.visibilityMs)} / ${visibility.polls} | ${Math.round(timed.elapsedMs)} | ${
          outstanding.length
        } |`
      );
    }
    /* eslint-enable no-await-in-loop */
    fs.writeFileSync(path.join(outputDir, 'summary.md'), `${summary.join(os.EOL)}${os.EOL}`);
    process.stdout.write(`${summary.join(os.EOL)}${os.EOL}`);
  } finally {
    if (process.env.STL_PROFILE_DELETE_ORG === 'true')
      await run('sf', ['org', 'delete', 'scratch', '--target-org', alias, '--no-prompt']).catch(() => undefined);
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}${os.EOL}`);
  process.exitCode = 1;
});
