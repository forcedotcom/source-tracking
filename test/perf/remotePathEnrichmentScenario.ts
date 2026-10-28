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
import { populateFilePaths } from '../../src/shared/populateFilePaths';
import { ChangeResult } from '../../src/shared/types';
import { measureSharedEventLoop } from './sharedEventLoop';

const bundleCount = Number(process.env.STL_REMOTE_PATH_BUNDLES ?? '500');
if (!Number.isInteger(bundleCount) || bundleCount < 1) {
  throw new Error('STL_REMOTE_PATH_BUNDLES must be a positive integer');
}

const bundleXml = (name: string) =>
  `<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><isExposed>false</isExposed><masterLabel>${name}</masterLabel></LightningComponentBundle>`;

const main = async (): Promise<void> => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'stl-remote-path-enrichment-'));
  const lwcPath = path.join(projectPath, 'force-app', 'main', 'default', 'lwc');
  const elements: ChangeResult[] = [];
  try {
    await Promise.all(
      Array.from({ length: bundleCount }, async (_unused, index) => {
        const name = `remotePath${String(index).padStart(4, '0')}`;
        const bundlePath = path.join(lwcPath, name);
        await fs.mkdir(bundlePath, { recursive: true });
        await Promise.all([
          fs.writeFile(
            path.join(bundlePath, `${name}.js`),
            `import { LightningElement } from 'lwc'; export default class ${name} extends LightningElement {}`
          ),
          fs.writeFile(path.join(bundlePath, `${name}.html`), '<template></template>'),
          fs.writeFile(path.join(bundlePath, `${name}.js-meta.xml`), bundleXml(name)),
        ]);
        elements.push({ origin: 'remote', name, type: 'LightningComponentBundle' });
      })
    );

    const measurement = await measureSharedEventLoop(async () =>
      populateFilePaths({
        elements,
        packageDirPaths: [path.join(projectPath, 'force-app')],
        registry: new RegistryAccess(),
      })
    );
    process.stdout.write(
      `${JSON.stringify({
        name: 'remote-path-enrichment',
        bundleCount,
        changeCount: elements.length,
        pathBearingChangeCount: measurement.result.filter((element) => element.filenames?.length).length,
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
