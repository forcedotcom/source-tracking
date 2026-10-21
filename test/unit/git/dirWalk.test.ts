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
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import sinon from 'sinon';
import * as Effect from 'effect/Effect';
import { FileSystem, makeNoop } from 'effect/FileSystem';
import * as Scheduler from 'effect/Scheduler';
import * as Schema from 'effect/Schema';
import * as NodePath from '@effect/platform-node/NodePath';
import { nodeIgnores, walkAllRoots } from '../../../src/git/dirWalk.js';
import { RepoPath } from '../../../src/git/schemas.js';

describe('git/dirWalk', () => {
  for (const fdPermits of [1, 2, 4]) {
    it(`shares ${fdPermits} I/O permits across wide, deep, multi-root walks`, async () => {
      const thisFile = fileURLToPath(import.meta.url);
      const [fileStat, dirStat] = await Promise.all([fs.lstat(thisFile), fs.lstat(path.dirname(thisFile))]);
      const dir = path.resolve('virtual-walk');
      const childrenByDir = new Map<string, string[]>();
      const expectedDirs: string[] = [];
      const addDir = (rel: string, depth: number): void => {
        expectedDirs.push(rel);
        const subdirs = depth === 0 ? [] : ['a', 'b', 'c'];
        childrenByDir.set(path.join(dir, rel), ['.gitignore', 'drop.log', 'keep.log', ...subdirs]);
        for (const child of subdirs) addDir(`${rel}/${child}`, depth - 1);
      };
      addDir('root-a', 3);
      addDir('root-b', 3);

      const tasks: Array<() => void> = [];
      const flush = (): void => {
        while (tasks.length > 0) tasks.shift()?.();
      };
      const scheduler: Scheduler.Scheduler = {
        executionMode: 'sync',
        shouldYield: () => false,
        makeDispatcher: () => ({ scheduleTask: (task) => tasks.push(task), flush }),
      };

      const pending: Array<() => void> = [];
      const operations = { lstat: 0, readDirectory: 0, readFile: 0 };
      let active = 0;
      let maxActive = 0;
      const start = (method: keyof typeof operations, complete: () => void): void => {
        operations[method]++;
        active++;
        maxActive = Math.max(maxActive, active);
        pending.push(() => {
          active--;
          complete();
        });
      };
      const platform = makeNoop({
        readDirectory: (abs) =>
          Effect.callback((resume) => {
            start('readDirectory', () => resume(Effect.succeed(childrenByDir.get(abs) ?? [])));
          }),
        readFile: () =>
          Effect.callback((resume) => {
            start('readFile', () => resume(Effect.succeed(new TextEncoder().encode('*.log\n!keep.log\n'))));
          }),
      });
      // The stub implements fs.lstat's native Promise contract so the test controls each completion.
      const lstatStub = sinon.stub(fs, 'lstat').callsFake(
        (abs) =>
          // @effect-diagnostics-next-line newPromise:off
          new Promise((resolve) => {
            start('lstat', () => resolve(childrenByDir.has(String(abs)) ? dirStat : fileStat));
          })
      );
      syncBuiltinESMExports();
      // @effect-diagnostics-next-line strictEffectProvide:off
      const fiber = Effect.runFork(
        walkAllRoots(
          { dir, roots: ['root-a', 'root-b'].map((root) => Schema.decodeUnknownSync(RepoPath)(root)), fdPermits },
          '*.tmp\n'
        ).pipe(
          Effect.provideService(FileSystem, platform),
          Effect.provide(NodePath.layer),
          Effect.provideService(Scheduler.Scheduler, scheduler)
        )
      );
      try {
        // Drain runnable fibers, then release exactly one mocked I/O operation.
        // Promise microtasks deliver lstat results; no sleeps or wall-clock races.
        while (fiber.pollUnsafe() === undefined) {
          flush();
          if (fiber.pollUnsafe() !== undefined) break;
          expect(pending, 'walk must make progress without holding permits across recursion').not.to.be.empty;
          pending.shift()?.();
          // eslint-disable-next-line no-await-in-loop -- advance one controlled I/O completion at a time
          await Promise.resolve();
        }
        const result = Effect.runSync(fiber.pollUnsafe()!);
        expect(maxActive).to.equal(fdPermits);
        expect(active).to.equal(0);
        expect(pending).to.be.empty;
        expect(operations.readDirectory).to.equal(expectedDirs.length);
        expect(operations.readFile).to.equal(expectedDirs.length);
        expect(operations.lstat).to.be.greaterThan(expectedDirs.length * 3);
        expect(result.nodes.map((node) => node.snapshot.dir)).to.deep.equal(expectedDirs);
        expect(result.isIgnoredAtRoot('anything.tmp')).to.equal(true);
        for (const node of result.nodes) {
          expect(node.snapshot.fileNames).to.deep.equal(['drop.log', 'keep.log']);
          expect(nodeIgnores(node, `${node.snapshot.dir}/drop.log`)).to.equal(true);
          expect(nodeIgnores(node, `${node.snapshot.dir}/keep.log`)).to.equal(false);
        }
      } finally {
        fiber.interruptUnsafe();
        flush();
        lstatStub.restore();
        syncBuiltinESMExports();
      }
    });
  }
});
