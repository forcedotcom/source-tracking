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

  it('returns an empty array for empty input', () => {
    expect(populateTypesAndNames({ projectPath, registry })([])).to.deep.equal([]);
  });

  it('resolves an Apex class to its type and name', () => {
    const input: ChangeResult[] = [{ origin: 'local', filenames: [apexMeta] }];
    const [result] = populateTypesAndNames({ projectPath, registry })(input);
    expect(result.type).to.equal('ApexClass');
    expect(result.name).to.equal('OrderController');
  });

  it('resolves multiple LWC bundle files to the same component type/name', () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: [path.join(lwcDir, 'accountMap', 'accountMap.js')] },
      { origin: 'local', filenames: [path.join(lwcDir, 'accountMap', 'accountMap.html')] },
    ];
    const results = populateTypesAndNames({ projectPath, registry })(input);
    expect(results).to.have.length(2);
    results.forEach((r) => {
      expect(r.type).to.equal('LightningComponentBundle');
      expect(r.name).to.equal('accountMap');
    });
  });

  it('marks a component as ignored when a content file matches .forceignore', () => {
    // **/jsconfig.json is in the ebikes .forceignore. Writing one inside the bundle
    // means forceIgnoreDenies returns true for this component.
    const createCaseDir = path.join(projectPath, lwcDir, 'createCase');
    fs.writeFileSync(path.join(createCaseDir, 'jsconfig.json'), '{}');

    const forceIgnore = ForceIgnore.findAndCreate(projectPath);
    const input: ChangeResult[] = [
      { origin: 'local', filenames: [path.join(lwcDir, 'createCase', 'createCase.js-meta.xml')] },
    ];
    const [result] = populateTypesAndNames({ projectPath, registry, forceIgnore })(input);
    expect(result.ignored).to.equal(true);
  });

  it('excludes unresolvable filenames when excludeUnresolvable is true', () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: ['force-app/main/default/classes/DoesNotExist.cls-meta.xml'] },
    ];
    expect(populateTypesAndNames({ projectPath, registry, excludeUnresolvable: true })(input)).to.deep.equal([]);
  });

  it('preserves unresolvable elements when excludeUnresolvable is false', () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: ['force-app/main/default/classes/DoesNotExist.cls-meta.xml'] },
    ];
    const [result] = populateTypesAndNames({ projectPath, registry })(input);
    expect(result.origin).to.equal('local');
    expect(result.type).to.equal(undefined);
    expect(result.name).to.equal(undefined);
  });
});
