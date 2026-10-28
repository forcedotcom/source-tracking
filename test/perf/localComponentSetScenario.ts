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
import { getComponentSets } from '../../src/shared/localComponentSetArray';
import { measureSharedEventLoop } from './sharedEventLoop';

const objectCount = Number(process.env.STL_LOCAL_COMPONENT_SET_OBJECTS ?? '100');
const fieldsPerObject = Number(process.env.STL_LOCAL_COMPONENT_SET_FIELDS ?? '50');
const bundleCount = Number(process.env.STL_LOCAL_COMPONENT_SET_BUNDLES ?? '50');
if (!Number.isInteger(objectCount) || objectCount < 1) {
  throw new Error('STL_LOCAL_COMPONENT_SET_OBJECTS must be a positive integer');
}
if (!Number.isInteger(fieldsPerObject) || fieldsPerObject < 1) {
  throw new Error('STL_LOCAL_COMPONENT_SET_FIELDS must be a positive integer');
}
if (!Number.isInteger(bundleCount) || bundleCount < 1) {
  throw new Error('STL_LOCAL_COMPONENT_SET_BUNDLES must be a positive integer');
}

const objectXml = (name: string) =>
  `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>${name}</label><pluralLabel>${name}</pluralLabel><nameField><label>Name</label><type>Text</type></nameField><deploymentStatus>Deployed</deploymentStatus><sharingModel>ReadWrite</sharingModel></CustomObject>`;
const fieldXml = (name: string) =>
  `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>${name}</fullName><label>${name}</label><type>Text</type><length>80</length></CustomField>`;
const lwcMetaXml = (name: string) =>
  `<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><isExposed>false</isExposed><masterLabel>${name}</masterLabel></LightningComponentBundle>`;
const auraMetaXml = () =>
  '<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion></AuraDefinitionBundle>';

const main = async (): Promise<void> => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'stl-local-component-set-'));
  const sourcePath = path.join(projectPath, 'force-app', 'main', 'default');
  const changedFiles: string[] = [];
  try {
    await Promise.all(
      Array.from({ length: objectCount }, async (_unused, objectIndex) => {
        const objectName = `SharedLoopObject${String(objectIndex).padStart(3, '0')}__c`;
        const objectDir = path.join(sourcePath, 'objects', objectName);
        const fields = path.join(objectDir, 'fields');
        await fs.mkdir(fields, { recursive: true });
        const objectFile = path.join(objectDir, `${objectName}.object-meta.xml`);
        changedFiles.push(path.relative(projectPath, objectFile));
        await fs.writeFile(objectFile, objectXml(objectName));
        await Promise.all(
          Array.from({ length: fieldsPerObject }, async (_field, fieldIndex) => {
            const fieldFile = path.join(fields, `Field${String(fieldIndex).padStart(3, '0')}__c.field-meta.xml`);
            changedFiles.push(path.relative(projectPath, fieldFile));
            await fs.writeFile(fieldFile, fieldXml(`Field${String(fieldIndex).padStart(3, '0')}__c`));
          })
        );
      })
    );
    await Promise.all(
      Array.from({ length: bundleCount }, async (_unused, bundleIndex) => {
        const name = `sharedLoop${String(bundleIndex).padStart(3, '0')}`;
        const lwcDir = path.join(sourcePath, 'lwc', name);
        const auraDir = path.join(sourcePath, 'aura', `${name}Aura`);
        const apexDir = path.join(sourcePath, 'classes');
        await Promise.all([
          fs.mkdir(lwcDir, { recursive: true }),
          fs.mkdir(auraDir, { recursive: true }),
          fs.mkdir(apexDir, { recursive: true }),
        ]);
        const files = [
          [
            path.join(lwcDir, `${name}.js`),
            `import { LightningElement } from 'lwc'; export default class ${name} extends LightningElement {}`,
          ],
          [path.join(lwcDir, `${name}.html`), '<template></template>'],
          [path.join(lwcDir, `${name}.js-meta.xml`), lwcMetaXml(name)],
          [path.join(auraDir, `${name}Aura.cmp`), '<aura:component></aura:component>'],
          [path.join(auraDir, `${name}Aura.cmp-meta.xml`), auraMetaXml()],
          [path.join(apexDir, `${name}Controller.cls`), `public class ${name}Controller {}`],
          [
            path.join(apexDir, `${name}Controller.cls-meta.xml`),
            '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>',
          ],
        ] as const;
        files.forEach(([file]) => changedFiles.push(path.relative(projectPath, file)));
        await Promise.all(files.map(([file, contents]) => fs.writeFile(file, contents)));
      })
    );

    const measurement = await measureSharedEventLoop(() =>
      getComponentSets({
        groupings: [{ path: 'force-app', nonDeletes: changedFiles, deletes: [] }],
        registry: new RegistryAccess(),
        projectPath,
      })
    );
    process.stdout.write(
      `${JSON.stringify({
        name: 'local-component-set',
        objectCount,
        fieldsPerObject,
        bundleCount,
        changedFileCount: changedFiles.length,
        componentCount: measurement.result[0]?.size ?? 0,
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
