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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SfProject } from '@salesforce/core';
import git from 'isomorphic-git';
import { measureSharedEventLoop } from './sharedEventLoop';

const projectPath = process.env.STL_STATUS_MATRIX_PROJECT_PATH;
const orgId = process.env.STL_STATUS_MATRIX_ORG_ID;
const mode = process.env.STL_STATUS_MATRIX_ITERATE ?? 'default';
const batchSize = Number(process.env.STL_STATUS_MATRIX_BATCH_SIZE ?? '32');
if (!projectPath || !orgId) {
  throw new Error('STL_STATUS_MATRIX_PROJECT_PATH and STL_STATUS_MATRIX_ORG_ID are required');
}
if (!['default', 'bounded'].includes(mode)) {
  throw new Error('STL_STATUS_MATRIX_ITERATE must be "default" or "bounded"');
}
if (!Number.isInteger(batchSize) || batchSize < 1) {
  throw new Error('STL_STATUS_MATRIX_BATCH_SIZE must be a positive integer');
}

type Iterate = (walk: (child: unknown) => Promise<unknown>, children: Iterable<unknown>) => Promise<unknown[]>;
type StatusMatrixOptions = Parameters<typeof git.statusMatrix>[0] & { iterate?: Iterate };

const boundedWithMacrotaskYield =
  (size: number): Iterate =>
  async (walk, children) => {
    const results: unknown[] = [];
    let batch: unknown[] = [];
    for (const child of children) {
      batch.push(child);
      if (batch.length < size) continue;
      // eslint-disable-next-line no-await-in-loop
      results.push(...(await Promise.all(batch.map(walk))));
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setImmediate(resolve));
      batch = [];
    }
    if (batch.length > 0) results.push(...(await Promise.all(batch.map(walk))));
    return results;
  };

const main = async (): Promise<void> => {
  const project = await SfProject.resolve(projectPath);
  const packageDirs = project
    .getPackageDirectories()
    .map((dir) => path.relative(projectPath, dir.fullPath).split(path.sep).join('/'));
  const gitdir = path.join(projectPath, '.sf', 'orgs', orgId, 'localSourceTracking');
  const options: StatusMatrixOptions = {
    fs,
    dir: projectPath,
    gitdir,
    filepaths: packageDirs,
    ignored: true,
  };
  if (mode === 'bounded') options.iterate = boundedWithMacrotaskYield(batchSize);

  const measurement = await measureSharedEventLoop(() => git.statusMatrix(options));
  process.stdout.write(
    `${JSON.stringify({
      name: 'status-matrix-iteration',
      mode,
      batchSize: mode === 'bounded' ? batchSize : undefined,
      projectPath,
      orgId,
      statusRows: measurement.result.length,
      statusDigest: createHash('sha256').update(JSON.stringify(measurement.result)).digest('hex'),
      ...measurement.stats,
    })}${os.EOL}`
  );
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}${os.EOL}`);
  process.exitCode = 1;
});
