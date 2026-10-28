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
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../src/shared/local/localShadowRepo';
import { measureSharedEventLoop } from './sharedEventLoop';

// Developer-only experiment inputs. They are not Source Tracking or IDE settings.
const fixture = process.env.STL_LOCAL_MOVE_FIXTURE ?? 'apex';
if (fixture !== 'apex' && fixture !== 'decomposed-object') {
  throw new Error('STL_LOCAL_MOVE_FIXTURE must be apex or decomposed-object');
}
const classCount = Number(process.env.STL_LOCAL_MOVE_CLASS_COUNT ?? '100');
const bytesPerFile = Number(process.env.STL_LOCAL_MOVE_BYTES_PER_FILE ?? '1024');
const MAX_APEX_CLASS_CHARS = 1_000_000;
if (fixture === 'apex') {
  for (const [name, value] of [
    ['STL_LOCAL_MOVE_CLASS_COUNT', classCount],
    ['STL_LOCAL_MOVE_BYTES_PER_FILE', bytesPerFile],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (bytesPerFile > MAX_APEX_CLASS_CHARS) {
    throw new Error(`STL_LOCAL_MOVE_BYTES_PER_FILE must not exceed ${MAX_APEX_CLASS_CHARS} for ApexClass fixtures`);
  }
} else if (process.env.STL_LOCAL_MOVE_CLASS_COUNT || process.env.STL_LOCAL_MOVE_BYTES_PER_FILE) {
  throw new Error('STL_LOCAL_MOVE_CLASS_COUNT and STL_LOCAL_MOVE_BYTES_PER_FILE apply only to apex fixtures');
}

const isTrue = (value: string | undefined): boolean => value?.toLowerCase() === 'true' || value === '1';

for (const name of ['SF_SOURCE_TRACKING_ASSUME_SYNCED', 'SF_DISABLE_SOURCE_MOBILITY'] as const) {
  if (isTrue(process.env[name])) throw new Error(`${name} disables the measured lifecycle`);
}

const sized = (prefix: string, suffix: string): string => {
  const minimumBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  if (bytesPerFile < minimumBytes) {
    throw new Error(`STL_LOCAL_MOVE_BYTES_PER_FILE must be at least ${minimumBytes} for this fixture`);
  }
  return `${prefix}${'x'.repeat(bytesPerFile - minimumBytes)}${suffix}`;
};

const memory = (): Record<string, number> => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
};

const decomposedObjectXml =
  '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><deploymentStatus>Deployed</deploymentStatus><label>Move Scenario</label><pluralLabel>Move Scenarios</pluralLabel><nameField><label>Move Scenario Name</label><type>Text</type></nameField><sharingModel>ReadWrite</sharingModel></CustomObject>';
const decomposedFieldXml =
  '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Description__c</fullName><label>Description</label><required>false</required><type>TextArea</type></CustomField>';

const main = async (): Promise<void> => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'stl-local-move-detection-'));
  const sourceRoot = path.join(projectPath, 'force-app', 'main', 'default');
  const movedRoot = path.join(projectPath, 'force-app', 'main', 'moved');
  try {
    const sourcePath =
      fixture === 'apex' ? path.join(sourceRoot, 'classes') : path.join(sourceRoot, 'objects', 'MoveScenario__c');
    const movedPath =
      fixture === 'apex' ? path.join(movedRoot, 'classes') : path.join(movedRoot, 'objects', 'MoveScenario__c');
    const files =
      fixture === 'apex'
        ? Array.from({ length: classCount }, (_unused, index) => {
            const name = `MoveScenario${String(index).padStart(5, '0')}`;
            return [
              [`${name}.cls`, sized(`public class ${name} { /*`, '*/ }')],
              [
                `${name}.cls-meta.xml`,
                sized('<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><!--', '--></ApexClass>'),
              ],
            ] as const;
          }).flat()
        : [
            ['MoveScenario__c.object-meta.xml', decomposedObjectXml],
            [path.join('fields', 'Description__c.field-meta.xml'), decomposedFieldXml],
          ];
    await Promise.all(
      files.map(async ([relativePath, contents]) => {
        const filePath = path.join(sourcePath, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents);
      })
    );

    const repo = await ShadowRepo.getInstance({
      orgId: 'moveDetectionScenario',
      projectPath,
      packageDirs: [{ name: 'force-app', path: 'force-app', fullPath: path.join(projectPath, 'force-app') }],
      registry: new RegistryAccess(),
    });
    await repo.commitChanges({ deployedFiles: await repo.getChangedFilenames(), needsUpdatedStatus: false });
    await fs.mkdir(path.dirname(movedPath), { recursive: true });
    await fs.rename(sourcePath, movedPath);

    let memoryBefore: Record<string, number> | undefined;
    let memoryAfter: Record<string, number> | undefined;
    const measurement = await measureSharedEventLoop(async () => {
      memoryBefore = memory();
      const status = await repo.getStatus(true);
      memoryAfter = memory();
      return {
        statusRowCount: status.length,
        changedRowCount: status.filter((row) => row[1] !== row[2]).length,
        statusPaths: status.map((row) => row[0]),
      };
    });
    const expectedFileCount = files.length;
    const expectedMovedPrefix = path.relative(projectPath, movedPath);
    if (
      measurement.result.statusRowCount !== expectedFileCount ||
      measurement.result.changedRowCount !== 0 ||
      !measurement.result.statusPaths.every((statusPath) => statusPath.startsWith(expectedMovedPrefix))
    ) {
      throw new Error(`Move normalization failed: ${JSON.stringify(measurement.result)}`);
    }
    process.stdout.write(
      `${JSON.stringify({
        name: 'local-move-detection',
        node: process.version,
        platform: process.platform,
        fixture,
        classCount: fixture === 'apex' ? classCount : null,
        bytesPerFile: fixture === 'apex' ? bytesPerFile : null,
        fixtureFileCount: expectedFileCount,
        fixtureContentBytes: files.reduce((total, [, contents]) => total + Buffer.byteLength(contents), 0),
        candidatePathCount: expectedFileCount * 2,
        candidateContentBytes: files.reduce((total, [, contents]) => total + Buffer.byteLength(contents) * 2, 0),
        candidateCountsAreFixtureDerived: true,
        operation: 'forced status scan, move detection, normalization commit, and refreshed status scan',
        environment: {
          sourceTrackingBatchSize: process.env.SF_SOURCE_TRACKING_BATCH_SIZE ?? null,
          legacySourceTrackingBatchSize: process.env.SFDX_SOURCE_TRACKING_BATCH_SIZE ?? null,
          sourceTrackingAssumeSynced: process.env.SF_SOURCE_TRACKING_ASSUME_SYNCED ?? null,
          sourceTrackingDisableMobility: process.env.SF_DISABLE_SOURCE_MOBILITY ?? null,
        },
        statusRowCount: measurement.result.statusRowCount,
        changedRowCount: measurement.result.changedRowCount,
        memoryBefore,
        memoryAfter,
        memorySnapshotsAreNotPeakMeasurements: true,
        ...measurement.stats,
      })}${os.EOL}`
    );
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}${os.EOL}`);
  process.exitCode = 1;
});
