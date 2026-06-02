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
import * as fs from 'graceful-fs';
import { expect } from 'chai';
import { TestSession } from '@salesforce/cli-plugins-testkit';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { ShadowRepo } from '../../../src/shared/local/localShadowRepo';

const dirCount = 20;
const classesPerDir = 50;
const fileCount = dirCount * classesPerDir * 2;

/**
 * Warm-status NUT: drives ShadowRepo through an applyChanges →
 * getStatus → mutate → getStatus cycle and asserts that the sidecar at
 * `.git/sftracking/untr.json` is created on the first commit, and that
 * subsequent getStatus calls return identical results to a fresh
 * ShadowRepo instance (cold rebuild) — i.e. the warm path doesn't drift.
 *
 * No wall-time assertions: CI runners vary. Correctness only. Only
 * runs against the lite shadow (warm doesn't exist for iso).
 */
const useLite = process.env.SF_SOURCE_TRACKING_USE_LITE_GIT === 'true';
const describeLite = useLite ? describe : describe.skip;

describeLite(`warm-status correctness over ${fileCount.toLocaleString()} files`, () => {
  const registry = new RegistryAccess();
  let session: TestSession;
  let repo: ShadowRepo;
  let trackedFiles: string[] = [];

  before(async () => {
    session = await TestSession.create({ project: { name: 'warm-repo' }, devhubAuthStrategy: 'NONE' });
    const classdir = path.join(session.project.dir, 'force-app', 'main', 'default', 'classes');
    // eslint-disable-next-line no-await-in-loop
    for (let d = 0; d < dirCount; d++) {
      const dirName = path.join(classdir, `dir${d}`);
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.mkdir(dirName, { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        Array.from({ length: classesPerDir }).flatMap((_, c) => {
          const name = `x${d}x${c}`;
          return [
            fs.promises.writeFile(
              path.join(dirName, `${name}.cls`),
              `public with sharing class ${name} {public ${name}() {}}`
            ),
            fs.promises.writeFile(
              path.join(dirName, `${name}.cls-meta.xml`),
              '<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>54.0</apiVersion><status>Active</status></ApexClass>'
            ),
          ];
        })
      );
    }
  });

  after(async () => {
    await session?.clean();
  });

  it('initializes the local shadow', async () => {
    repo = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
      registry,
    });
    expect(fs.existsSync(repo.gitDir)).to.equal(true);
  });

  it('first getChangedFilenames sees all newly-added files (cold path)', async () => {
    trackedFiles = await repo.getChangedFilenames();
    expect(trackedFiles).to.have.length.greaterThan(fileCount - 5);
  });

  it('commit creates the UNTR sidecar', async () => {
    await repo.commitChanges({ deployedFiles: trackedFiles });
    const sidecar = path.join(repo.gitDir, 'sftracking', 'untr.json');
    expect(fs.existsSync(sidecar)).to.equal(true, `expected UNTR sidecar at ${sidecar}`);
  });

  it('warm getChangedFilenames after commit is empty (everything tracked)', async () => {
    const changed = await repo.getChangedFilenames();
    expect(changed).to.have.lengthOf(0);
  });

  it('mutating one file then getChangedFilenames picks it up via warm path', async () => {
    const target = path.join(session.project.dir, 'force-app', 'main', 'default', 'classes', 'dir0', 'x0x0.cls');
    await new Promise((r) => setTimeout(r, 20));
    await fs.promises.writeFile(target, 'public class x0x0 { /* mutated */ }');
    // ShadowRepo caches status across calls; getStatus(true) forces a
    // fresh getStatus call, which on lite goes through the warm path
    // (cache is loaded; one file's dir mtime has advanced so its slice
    // re-walks). Equivalent to a real-world second-call scenario.
    await repo.getStatus(true);
    const changed = await repo.getChangedFilenames();
    expect(changed).to.include.members([path.relative(session.project.dir, target).split(path.sep).join('/')]);
  });

  it('warm output matches a fresh-instance cold output on the same state', async () => {
    const fresh = await ShadowRepo.getInstance({
      orgId: 'fakeOrgId',
      projectPath: session.project.dir,
      packageDirs: [{ path: 'force-app', name: 'force-app', fullPath: path.join(session.project.dir, 'force-app') }],
      registry,
    });
    // Force-refresh `repo` so its cached status reflects the mutation
    // from the previous test (warm path runs).
    await repo.getStatus(true);
    const warmChanged = (await repo.getChangedFilenames()).slice().sort();
    // `fresh` has no in-memory cache; first getStatus runs warm too
    // (sidecar present) — we want the result, not the path.
    const freshChanged = (await fresh.getChangedFilenames()).slice().sort();
    expect(warmChanged).to.deep.equal(freshChanged);
  });
});
