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
import { correctSourceMemberNames } from '../../src/sourceTracking';
import { measureSharedEventLoop } from './sharedEventLoop';

const objectCount = Number(process.env.STL_REMOTE_CRAWL_OBJECTS ?? '100');
const fieldsPerObject = Number(process.env.STL_REMOTE_CRAWL_FIELDS ?? '50');
if (!Number.isInteger(objectCount) || objectCount < 1)
  throw new Error('STL_REMOTE_CRAWL_OBJECTS must be a positive integer');
if (!Number.isInteger(fieldsPerObject) || fieldsPerObject < 1) {
  throw new Error('STL_REMOTE_CRAWL_FIELDS must be a positive integer');
}
const fileCount = objectCount * (fieldsPerObject + 1);

const change = (type: string, name: string) => ({
  name,
  type,
  deleted: false,
  modified: true,
  changedBy: 'shared-loop-profile',
  revisionCounter: 1,
  lastModifiedDate: new Date(0).toJSON(),
  memberIdOrName: '00e000000000001AAA',
});

const objectXml = (name: string) =>
  `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>${name}</label><pluralLabel>${name}</pluralLabel><nameField><label>Name</label><type>Text</type></nameField><deploymentStatus>Deployed</deploymentStatus><sharingModel>ReadWrite</sharingModel></CustomObject>`;
const fieldXml = (name: string) =>
  `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>${name}</fullName><label>${name}</label><type>Text</type><length>80</length></CustomField>`;

const format = (name: string, stats: Awaited<ReturnType<typeof measureSharedEventLoop<unknown>>>['stats']) =>
  JSON.stringify({ name, objectCount, fieldsPerObject, fileCount, ...stats });

const main = async (): Promise<void> => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'stl-remote-name-crawl-'));
  try {
    const objects = path.join(projectPath, 'main', 'default', 'objects');
    await fs.mkdir(objects, { recursive: true });
    await Promise.all(
      Array.from({ length: objectCount }, async (_unused, objectIndex) => {
        const objectName = `SharedLoopObject${String(objectIndex).padStart(3, '0')}__c`;
        const objectDir = path.join(objects, objectName);
        const fields = path.join(objectDir, 'fields');
        await fs.mkdir(fields, { recursive: true });
        await Promise.all([
          fs.writeFile(path.join(objectDir, `${objectName}.object-meta.xml`), objectXml(objectName)),
          ...Array.from({ length: fieldsPerObject }, (_, fieldIndex) => {
            const fieldName = `Field${String(fieldIndex).padStart(3, '0')}__c`;
            return fs.writeFile(path.join(fields, `${fieldName}.field-meta.xml`), fieldXml(fieldName));
          }),
        ]);
      })
    );
    const registry = new RegistryAccess();
    const noCorrection = await measureSharedEventLoop(async () =>
      correctSourceMemberNames([change('CustomField', 'SharedLoopObject000__c.Field000__c')], [projectPath], registry)
    );
    const requiresCorrection = await measureSharedEventLoop(async () =>
      correctSourceMemberNames([change('NavigationMenu', 'Default_Navigation')], [projectPath], registry)
    );
    process.stdout.write(`${format('no-name-correction', noCorrection.stats)}${os.EOL}`);
    process.stdout.write(`${format('requires-name-correction', requiresCorrection.stats)}${os.EOL}`);
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}${os.EOL}`);
  process.exitCode = 1;
});
