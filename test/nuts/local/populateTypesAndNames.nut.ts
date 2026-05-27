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
import * as Effect from 'effect/Effect';
import { ForceIgnore, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { populateTypesAndNames } from '../../../src/shared/populateTypesAndNames';
import { populateTypesAndNamesLegacy } from '../../../src/shared/populateTypesAndNamesLegacy';
import { ChangeResult } from '../../../src/shared/types';

const run = <A>(eff: Effect.Effect<A>): Promise<A> => Effect.runPromise(eff);

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
    expect(await run(populateTypesAndNames({ projectPath, registry })([]))).to.deep.equal([]);
  });

  it('resolves an Apex class to its type and name', async () => {
    const input: ChangeResult[] = [{ origin: 'local', filenames: [apexMeta] }];
    const [result] = await run(populateTypesAndNames({ projectPath, registry })(input));
    expect(result.type).to.equal('ApexClass');
    expect(result.name).to.equal('OrderController');
  });

  it('resolves multiple LWC bundle files to the same component type/name', async () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: [path.join(lwcDir, 'accountMap', 'accountMap.js')] },
      { origin: 'local', filenames: [path.join(lwcDir, 'accountMap', 'accountMap.html')] },
    ];
    const results = await run(populateTypesAndNames({ projectPath, registry })(input));
    expect(results).to.have.length(2);
    results.forEach((r) => {
      expect(r.type).to.equal('LightningComponentBundle');
      expect(r.name).to.equal('accountMap');
    });
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
    const [result] = await run(populateTypesAndNames({ projectPath, registry, forceIgnore })(input));
    expect(result.ignored).to.equal(true);
  });

  it('excludes unresolvable filenames when excludeUnresolvable is true', async () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: ['force-app/main/default/classes/DoesNotExist.cls-meta.xml'] },
    ];
    expect(await run(populateTypesAndNames({ projectPath, registry, excludeUnresolvable: true })(input))).to.deep.equal(
      []
    );
  });

  it('preserves unresolvable elements when excludeUnresolvable is false', async () => {
    const input: ChangeResult[] = [
      { origin: 'local', filenames: ['force-app/main/default/classes/DoesNotExist.cls-meta.xml'] },
    ];
    const [result] = await run(populateTypesAndNames({ projectPath, registry })(input));
    expect(result.origin).to.equal('local');
    expect(result.type).to.equal(undefined);
    expect(result.name).to.equal(undefined);
  });

  // Pins the structural-equality dedup that diverges from legacy. Legacy used
  // identity dedup (`new Set(elementMap.values())`), which kept N copies of the
  // same patched ChangeResult when one input element carried N filenames in the
  // same bundle. The new code collapses them to one. This is the desired
  // behavior — duplicates would multiply downstream rows in
  // `localChangesToOutputRow`. The legacy run here documents the divergence.
  describe('multi-filename element in one bundle', () => {
    const input: ChangeResult[] = [
      {
        origin: 'local',
        filenames: [
          path.join(lwcDir, 'accountMap', 'accountMap.js'),
          path.join(lwcDir, 'accountMap', 'accountMap.html'),
          path.join(lwcDir, 'accountMap', 'accountMap.js-meta.xml'),
        ],
      },
    ];

    it('collapses to one element by structural equality', async () => {
      const results = await run(populateTypesAndNames({ projectPath, registry })(input));
      expect(results).to.have.length(1);
      expect(results[0].type).to.equal('LightningComponentBundle');
      expect(results[0].name).to.equal('accountMap');
    });

    it('legacy returns one entry per filename (documents divergence)', () => {
      const results = populateTypesAndNamesLegacy({ projectPath, registry })(input);
      expect(results).to.have.length(3);
      results.forEach((r) => {
        expect(r.type).to.equal('LightningComponentBundle');
        expect(r.name).to.equal('accountMap');
      });
    });
  });
});
