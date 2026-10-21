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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodePath from '@effect/platform-node/NodePath';
import * as Effect from 'effect/Effect';
import * as HashSet from 'effect/HashSet';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { Repo } from '../../src/git/repo.js';
import { RepoPath } from '../../src/git/schemas.js';
import { createShadowRepo } from '../../src/shared/local/localShadowRepo.js';
import { filenameMatchesToMap } from '../../src/shared/local/moveDetection.js';

const testLayer = Repo.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
);

describe('move detection exact matches', () => {
  for (const moveAndEdit of [false, true]) {
    it(
      moveAndEdit
        ? 'removes exact matches before matching an edited move with the same basename'
        : 'counts an exact move once without classifying it as modified',
      async () => {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moveDetectionTest'));
        try {
          const registry = new RegistryAccess();
          const oldFiles = (moveAndEdit ? ['exact', 'edited'] : ['exact']).map((folder) =>
            path.join('force-app', 'old', folder, 'labels', 'CustomLabels.labels-meta.xml')
          );
          const newFiles = (moveAndEdit ? ['exact', 'edited'] : ['exact']).map((folder) =>
            path.join('force-app', 'new', folder, 'labels', 'CustomLabels.labels-meta.xml')
          );
          oldFiles.forEach((filename, index) => {
            fs.mkdirSync(path.dirname(path.join(projectDir, filename)), { recursive: true });
            fs.writeFileSync(path.join(projectDir, filename), `<xml>original ${index}</xml>`);
          });
          const packageDir = path.join(projectDir, 'force-app');
          const shadowRepo = await createShadowRepo({
            orgId: '00D456789012345',
            projectPath: projectDir,
            packageDirs: [{ name: 'dummy', fullPath: packageDir, path: packageDir }],
            registry,
          });
          await shadowRepo.recordSync({ deployedFiles: oldFiles });

          oldFiles.forEach((filename, index) => {
            fs.mkdirSync(path.dirname(path.join(projectDir, newFiles[index])), { recursive: true });
            fs.renameSync(path.join(projectDir, filename), path.join(projectDir, newFiles[index]));
            if (index > 0) fs.appendFileSync(path.join(projectDir, newFiles[index]), '<xml>edited</xml>');
          });

          const result = await Effect.gen(function* () {
            const repo = yield* Repo;
            yield* repo.switchTo({
              dir: projectDir,
              gitdir: shadowRepo.gitDir,
              roots: [Schema.decodeUnknownSync(RepoPath)('force-app')],
              fdPermits: 8,
            });
            return yield* filenameMatchesToMap(registry)(projectDir)(8)({
              added: HashSet.fromIterable(newFiles),
              deleted: HashSet.fromIterable(oldFiles),
            });
          }).pipe(Effect.provide(testLayer), Effect.runPromise);

          expect(result.count).to.equal(oldFiles.length);
          expect(Array.from(result.deployedFiles)).to.deep.equal([newFiles[0]]);
          expect(Array.from(result.deletedFiles).sort()).to.deep.equal([...oldFiles].sort());
          expect(result.logMessage).to.equal(
            [
              'Files have moved. Committing moved files:',
              `- File ${oldFiles[0]} was moved to ${newFiles[0]}`,
              ...(moveAndEdit ? [`- File ${oldFiles[1]} was moved to ${newFiles[1]} and modified`] : []),
            ].join('\n')
          );
        } finally {
          await fs.promises.rm(projectDir, { recursive: true, force: true });
        }
      }
    );
  }
});
