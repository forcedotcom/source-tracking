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
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { expect } from 'chai';
import { ForceIgnore, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { populateTypesAndNames } from '../../../src/shared/populateTypesAndNames';
import { ChangeResult } from '../../../src/shared/types';
import { measureSharedEventLoop } from '../../perf/sharedEventLoop';

// TestSession stubs process.cwd() to the project dir, which causes maybeGetTreeContainer
// to return undefined and the resolver to use the real cwd (workspace root) for FS ops.
// Use mkdtempSync so process.cwd() !== projectPath and the NodeFSTreeContainer(projectPath)
// is used, making relative-path resolution work correctly.

const registry = new RegistryAccess();

// Relative paths matching what isogit/localShadowRepo returns
const apexMeta = path.join('force-app', 'main', 'default', 'classes', 'OrderController.cls-meta.xml');
const lwcDir = path.join('force-app', 'main', 'default', 'lwc');

describe('populateTypesAndNames', () => {
  let projectPath: string;

  before(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'populateTypesAndNames-'));
    fs.cpSync(path.resolve(path.join('test', 'nuts', 'ebikes-lwc')), projectPath, { recursive: true });
  });

  after(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('returns an empty array for empty input', async () => {
    expect(await populateTypesAndNames({ projectPath, registry })([])).to.deep.equal([]);
  });

  it('marks a component as ignored when a content file matches .forceignore', async () => {
    // **/jsconfig.json is in the ebikes .forceignore. Writing one inside the bundle
    // means forceIgnoreDenies returns true for this component.
    const createCaseDir = path.join(projectPath, lwcDir, 'createCase');
    fs.writeFileSync(path.join(createCaseDir, 'jsconfig.json'), '{}');

    const forceIgnore = ForceIgnore.findAndCreate(projectPath);
    const input: ChangeResult[] = [
      { origin: 'local', filenames: [path.join(lwcDir, 'createCase', 'createCase.js-meta.xml')] },
    ];
    const [result] = await populateTypesAndNames({ projectPath, registry, forceIgnore })(input);
    expect(result.ignored).to.equal(true);
  });

  it('resolves an Apex class to its type and name', async () => {
    const input: ChangeResult[] = [{ origin: 'local', filenames: [apexMeta] }];
    const [result] = await populateTypesAndNames({ projectPath, registry })(input);
    expect(result.type).to.equal('ApexClass');
    expect(result.name).to.equal('OrderController');
  });

  it('resolves multiple LWC bundle files to the same component type/name', async () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: [path.join(lwcDir, 'accountMap', 'accountMap.js')] },
      { origin: 'local', filenames: [path.join(lwcDir, 'accountMap', 'accountMap.html')] },
    ];
    const results = await populateTypesAndNames({ projectPath, registry })(input);
    expect(results).to.have.length(2);
    results.forEach((r) => {
      expect(r.type).to.equal('LightningComponentBundle');
      expect(r.name).to.equal('accountMap');
    });
  });

  it('allows a same-thread heartbeat during large local enrichment', async () => {
    const heartbeatProjectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'populateTypesAndNames-heartbeat-'));
    try {
      const classesDir = path.join(heartbeatProjectPath, 'force-app', 'main', 'default', 'classes');
      fs.mkdirSync(classesDir, { recursive: true });
      const changes = Array.from({ length: 201 }, (_, index) => {
        const name = `Heartbeat${String(index).padStart(3, '0')}`;
        fs.writeFileSync(path.join(classesDir, `${name}.cls`), `public class ${name} {}`);
        fs.writeFileSync(
          path.join(classesDir, `${name}.cls-meta.xml`),
          '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>'
        );
        return {
          origin: 'local' as const,
          filenames: [path.join('force-app', 'main', 'default', 'classes', `${name}.cls`)],
        };
      });

      const { result, stats } = await measureSharedEventLoop(() =>
        populateTypesAndNames({
          projectPath: heartbeatProjectPath,
          registry: new RegistryAccess(),
          excludeUnresolvable: true,
        })(changes)
      );
      expect(result).to.have.length(201);
      expect(stats.operationHeartbeatCount).to.be.greaterThan(0);
    } finally {
      fs.rmSync(heartbeatProjectPath, { recursive: true, force: true });
    }
  });

  it('excludes unresolvable filenames when excludeUnresolvable is true', async () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: ['force-app/main/default/classes/DoesNotExist.cls-meta.xml'] },
    ];
    expect(await populateTypesAndNames({ projectPath, registry, excludeUnresolvable: true })(input)).to.deep.equal([]);
  });

  it('preserves unresolvable elements when excludeUnresolvable is false', async () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: ['force-app/main/default/classes/DoesNotExist.cls-meta.xml'] },
    ];
    const [result] = await populateTypesAndNames({ projectPath, registry })(input);
    expect(result.origin).to.equal('local');
    expect(result.type).to.equal(undefined);
    expect(result.name).to.equal(undefined);
  });
});
