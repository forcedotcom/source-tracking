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
 * Profiles the high-object local-status hotspot without an org or metadata
 * deployment. The synthetic identity scopes only the on-disk shadow repo.
 */

import * as fs from 'node:fs';
import * as inspector from 'node:inspector';
import * as os from 'node:os';
import * as path from 'node:path';
import { SfProject } from '@salesforce/core';
import { Effect } from 'effect';
import { SourceTracking } from '../../src/sourceTracking.js';

const API_VERSION = '68.0';
const DEFAULT_OBJECTS = 2_000;
const DEFAULT_FIELDS_PER_OBJECT = 50;
const SYNTHETIC_ORG_ID = '00D000000000001EAA';

const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; received ${value}.`);
  return value;
};

const isEnabled = (name: string): boolean => process.env[name] === '1';

const post = (session: inspector.Session, method: string, params?: object): Promise<Record<string, unknown>> =>
  Effect.runPromise(
    Effect.callback<Record<string, unknown>, Error>((resume) => {
      session.post(method, params, (error, result) =>
        resume(error ? Effect.fail(error) : Effect.succeed((result ?? {}) as Record<string, unknown>))
      );
    })
  );

const objectName = (index: number): string => `StlLocalProfileObject${String(index).padStart(4, '0')}__c`;
const fieldName = (index: number): string => `Field${String(index).padStart(2, '0')}__c`;
const objectXml = (): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n  <deploymentStatus>Deployed</deploymentStatus>\n  <label>Local Profile Object</label>\n  <nameField><label>Local Profile Object Name</label><type>Text</type></nameField>\n  <pluralLabel>Local Profile Objects</pluralLabel>\n  <sharingModel>ReadWrite</sharingModel>\n</CustomObject>\n';
const fieldXml = (name: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>${name}</fullName>\n  <label>${name}</label>\n  <length>255</length>\n  <type>Text</type>\n</CustomField>\n`;

const createFixture = (projectPath: string, objects: number, fieldsPerObject: number): void => {
  const objectsPath = path.join(projectPath, 'force-app', 'main', 'default', 'objects');
  fs.mkdirSync(objectsPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'sfdx-project.json'),
    `${JSON.stringify(
      { packageDirectories: [{ path: 'force-app', default: true }], namespace: '', sourceApiVersion: API_VERSION },
      null,
      2
    )}${os.EOL}`
  );
  for (let objectIndex = 0; objectIndex < objects; objectIndex++) {
    const object = objectName(objectIndex);
    const fieldsPath = path.join(objectsPath, object, 'fields');
    fs.mkdirSync(fieldsPath, { recursive: true });
    fs.writeFileSync(path.join(objectsPath, object, `${object}.object-meta.xml`), objectXml());
    for (let fieldIndex = 0; fieldIndex < fieldsPerObject; fieldIndex++) {
      const field = fieldName(fieldIndex);
      fs.writeFileSync(path.join(fieldsPath, `${field}.field-meta.xml`), fieldXml(field));
    }
  }
};

const profile = async (outputDir: string, operation: () => Promise<void>): Promise<number> => {
  const session = new inspector.Session();
  session.connect();
  try {
    await post(session, 'Profiler.enable');
    await post(session, 'HeapProfiler.enable');
    await post(session, 'HeapProfiler.startSampling', { samplingInterval: 8_192 });
    await post(session, 'Profiler.start');
    const start = process.hrtime.bigint();
    await operation();
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const cpu = await post(session, 'Profiler.stop');
    const heap = await post(session, 'HeapProfiler.stopSampling');
    fs.writeFileSync(path.join(outputDir, 'local-status.cpuprofile'), JSON.stringify(cpu.profile));
    fs.writeFileSync(path.join(outputDir, 'local-status.heapprofile'), JSON.stringify(heap.profile));
    return elapsedMs;
  } finally {
    session.disconnect();
  }
};

const main = async (): Promise<void> => {
  const objects = positiveInteger('STL_LOCAL_PROFILE_OBJECTS', DEFAULT_OBJECTS);
  const fieldsPerObject = positiveInteger('STL_LOCAL_PROFILE_FIELDS_PER_OBJECT', DEFAULT_FIELDS_PER_OBJECT);
  const fixturePath =
    process.env.STL_LOCAL_PROFILE_FIXTURE_DIR ?? path.join(os.homedir(), 'stl-perf', 'local-profile-fixture');
  const outputDir =
    process.env.STL_LOCAL_PROFILE_OUTPUT_DIR ?? path.join(os.homedir(), 'stl-perf', 'profiles', 'local-status-2000x50');
  const reuseFixture = isEnabled('STL_LOCAL_PROFILE_REUSE_FIXTURE');
  if (fs.existsSync(fixturePath) && !reuseFixture) {
    throw new Error(
      `Fixture directory already exists: ${fixturePath}. Choose STL_LOCAL_PROFILE_FIXTURE_DIR or remove it before rebuilding.`
    );
  }
  fs.mkdirSync(outputDir, { recursive: true });
  if (!reuseFixture) createFixture(fixturePath, objects, fieldsPerObject);
  const project = await SfProject.resolve(fixturePath);
  // Local tracking reads only getOrgId; no org connection or network request is made.
  const tracking = await SourceTracking.create({ org: { getOrgId: () => SYNTHETIC_ORG_ID } as never, project });
  await tracking.resetLocalTracking();
  const elapsedMs = await profile(outputDir, () => tracking.reReadLocalTrackingCache());
  const changes = await tracking.getChanges({ origin: 'local', state: 'nondelete', format: 'string' });
  if (changes.length !== 0) throw new Error(`Expected a zero-change local scan; found ${changes.length} changes.`);
  const summary = [
    '# Local-status profile run',
    '',
    `- **fixture**: ${objects} objects x ${fieldsPerObject} fields`,
    `- **sourceFiles**: ${objects * (fieldsPerObject + 1)}`,
    `- **fixturePath**: ${fixturePath}`,
    `- **reusedFixture**: ${reuseFixture}`,
    `- **profiles**: ${outputDir}`,
    `- **syntheticOrgId**: ${SYNTHETIC_ORG_ID} (on-disk shadow-repo scope only)`,
    '',
    '| operation | ms | local changes |',
    '| --- | ---: | ---: |',
    `| forced zero-change reReadLocalTrackingCache | ${Math.round(elapsedMs)} | ${changes.length} |`,
    '',
  ].join(os.EOL);
  fs.writeFileSync(path.join(outputDir, 'summary.md'), summary);
  process.stdout.write(`${summary}${os.EOL}`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}${os.EOL}`);
  process.exitCode = 1;
});
