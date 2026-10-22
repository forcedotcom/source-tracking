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

/**
 * Perf NUT for populateTypesAndNames.
 *
 * Measures the Effect implementation on two fixtures (EDA + 35k generated
 * object/field files). Captures wall-clock + perf_hooks event-loop-delay
 * histogram per run. Writes per-run JSONL to the test session's directory.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { populateTypesAndNames as populateTypesAndNamesEffect } from '../../../src/shared/populateTypesAndNames.js';
import { ChangeResult } from '../../../src/shared/types.js';
import { PerfNutSdkLayer } from '../../perf-utils/sdkLayer.js';

type RunStats = {
  readonly variant: string;
  readonly fixture: string;
  readonly inputElements: number;
  readonly resultElements: number;
  readonly wallMs: number;
  readonly elP50Ms: number;
  readonly elP99Ms: number;
  readonly elMaxMs: number;
  readonly samples: number;
};

const ns = (h: ReturnType<typeof monitorEventLoopDelay>, p: number) => h.percentile(p) / 1_000_000;

const measure = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const histogram = monitorEventLoopDelay({ resolution: 1 });
      histogram.enable();
      return histogram;
    }),
    (histogram) =>
      Effect.gen(function* () {
        // Timer ticks, not setImmediate, must arm and drain the sampler.
        yield* Effect.sleep('10 millis');
        const start = performance.now();
        return yield* effect.pipe(
          Effect.map((result) => ({ result, wallMs: performance.now() - start })),
          Effect.tap(() => Effect.sleep('10 millis')),
          Effect.map(({ result, wallMs }) => ({
            result,
            stats: {
              wallMs,
              elP50Ms: ns(histogram, 50),
              elP99Ms: ns(histogram, 99),
              elMaxMs: histogram.max / 1_000_000,
              samples: histogram.count,
            },
          }))
        );
      }),
    (histogram) =>
      Effect.sync(() => {
        histogram.disable();
      })
  );
});

const expectWithinBudget = (stats: Pick<RunStats, 'samples' | 'wallMs' | 'elMaxMs'>): void => {
  expect(stats.samples, 'event-loop samples').to.be.greaterThan(0);
  expect(stats.wallMs, 'wall time').to.be.lessThan(process.platform === 'win32' ? 30_000 : 10_000);
  expect(stats.elMaxMs, 'maximum event-loop delay').to.be.lessThan(process.platform === 'win32' ? 250 : 100);
};

describe('event-loop sampling', () => {
  it('detects every deliberate synchronous block', async () => {
    await Effect.forEach([0, 1, 2, 3, 4, 5], () =>
      measure(
        Effect.sync(() => {
          const start = performance.now();
          // Deliberately block the event loop to validate the sampler.
          // eslint-disable-next-line functional/no-loop-statements
          while (performance.now() - start < 100) {
            /* block */
          }
        })
      ).pipe(
        Effect.tap(({ stats }) =>
          Effect.sync(() => {
            expect(stats.samples).to.be.greaterThan(0);
            expect(stats.elMaxMs).to.be.at.least(80);
          })
        )
      )
    ).pipe(Effect.runPromise);
  });
});

const writeStats = async (file: string, line: RunStats) => fs.appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');

const logRow = (row: RunStats, extra?: string) => {
  /* eslint-disable no-console */
  // @effect-diagnostics-next-line globalConsole:off
  console.log(
    `[perf] ${row.fixture} ${row.variant} input=${row.inputElements} result=${
      row.resultElements
    } wall=${row.wallMs.toFixed(1)}ms el-p99=${row.elP99Ms.toFixed(1)}ms el-max=${row.elMaxMs.toFixed(1)}ms${
      extra ? ` extra=${extra}` : ''
    }`
  );
  /* eslint-enable no-console */
};

const walkAllFiles = async (root: string): Promise<string[]> => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const full = path.join(root, e.name);
      return e.isDirectory() ? walkAllFiles(full) : Promise.resolve([full]);
    })
  );
  return nested.flat();
};

const buildInput =
  (projectPath: string) =>
  (filename: string): ChangeResult => ({
    origin: 'local',
    filenames: [path.relative(projectPath, filename)],
  });

// ────────────────────────────────────────────────────────────────────────────
// Fixture: EDA
// ────────────────────────────────────────────────────────────────────────────

type Ctx = {
  projectPath: string;
  elements: ChangeResult[];
  statsPath: string;
};

const cloneEda = (target: string) => {
  fsSync.mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '--quiet', target]);
  execFileSync('git', [
    '-C',
    target,
    'fetch',
    '--quiet',
    '--depth',
    '1',
    'https://github.com/SalesforceFoundation/EDA',
    'b311845eb082fc6b8fafdbcebdbe03cc570df3a6',
  ]);
  execFileSync('git', ['-C', target, 'checkout', '--quiet', 'FETCH_HEAD']);
};

describe('perf: populateTypesAndNames @ EDA', () => {
  const registry = new RegistryAccess();
  const ctx: Ctx = { projectPath: '', elements: [], statsPath: '' };

  before(async function () {
    this.timeout(180_000);
    ctx.projectPath = fsSync.mkdtempSync(path.join(os.tmpdir(), 'stl-perf-eda-'));
    cloneEda(ctx.projectPath);
    const forceApp = path.join(ctx.projectPath, 'force-app');
    const allFiles = await walkAllFiles(forceApp);
    ctx.elements = allFiles.map(buildInput(ctx.projectPath));
    ctx.statsPath = path.join(os.tmpdir(), 'stl-perf-stats.jsonl');
  });

  after(async () => {
    if (ctx.projectPath && process.env.STL_PERF_KEEP !== '1') {
      await fs.rm(ctx.projectPath, { recursive: true, force: true });
    }
  });

  it(`effect: measures ${process.env.STL_PERF_LABEL ?? 'EDA'}`, async () => {
    const { layer, spanFilePath } = PerfNutSdkLayer('eda-effect');
    const { result, stats } = await populateTypesAndNamesEffect({ projectPath: ctx.projectPath, registry })(
      ctx.elements
    ).pipe(measure, Effect.provide(layer), Effect.runPromise);
    const row: RunStats = {
      variant: 'effect',
      fixture: 'EDA',
      inputElements: ctx.elements.length,
      resultElements: result.length,
      ...stats,
    };
    await writeStats(ctx.statsPath, row);
    logRow(row, spanFilePath);
    expect(result).to.have.length(6462);
    expect(result.filter((r) => !r.name || !r.type).flatMap(({ filenames }) => filenames ?? [])).to.have.members([
      path.join('force-app', 'main', 'default', 'lwc', 'jsconfig.json'),
      path.join('force-app', 'main', 'settingsComponentLibrary', 'lwc', 'jsconfig.json'),
      path.join('force-app', 'test', 'jest-mocks', 'lightning', 'navigation.js'),
      path.join('force-app', 'test', 'jest-mocks', 'lightning', 'platformShowToastEvent.js'),
    ]);
    expectWithinBudget(stats);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture: synthetic 350 objects × 100 fields = 35k files
// ────────────────────────────────────────────────────────────────────────────

const objectXml = (i: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Perf Object ${i}</label>
    <nameField><label>Name</label><type>Text</type></nameField>
    <pluralLabel>Perf Objects ${i}</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`;

const fieldXml = (i: number) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>PerfField${String(i).padStart(3, '0')}__c</fullName>
    <label>Perf Field ${i}</label>
    <type>Text</type>
    <length>80</length>
    <required>false</required>
</CustomField>
`;

const OBJECT_COUNT = Number(process.env.STL_PERF_OBJECT_COUNT ?? '350');
const FIELDS_PER_OBJECT = Number(process.env.STL_PERF_FIELDS_PER_OBJECT ?? '100');

describe(`perf: populateTypesAndNames @ ${OBJECT_COUNT}x${FIELDS_PER_OBJECT} synthetic objects`, () => {
  const registry = new RegistryAccess();
  const ctx: Ctx = { projectPath: '', elements: [], statsPath: '' };

  before(async function () {
    this.timeout(180_000);
    ctx.projectPath = fsSync.mkdtempSync(path.join(os.tmpdir(), 'stl-perf-objs-'));
    await fs.writeFile(
      path.join(ctx.projectPath, 'sfdx-project.json'),
      JSON.stringify({
        packageDirectories: [{ path: 'force-app', default: true }],
        sourceApiVersion: '66.0',
      })
    );
    const objectsDir = path.join(ctx.projectPath, 'force-app', 'main', 'default', 'objects');
    await fs.mkdir(objectsDir, { recursive: true });

    const objectIndices = Array.from({ length: OBJECT_COUNT }, (_, i) => i);
    const fieldIndices = Array.from({ length: FIELDS_PER_OBJECT }, (_, i) => i);

    await objectIndices.reduce<Promise<void>>(async (acc, oi) => {
      await acc;
      const objName = `PerfObject${String(oi).padStart(3, '0')}__c`;
      const objDir = path.join(objectsDir, objName);
      const fieldsDir = path.join(objDir, 'fields');
      await fs.mkdir(fieldsDir, { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(objDir, `${objName}.object-meta.xml`), objectXml(oi)),
        ...fieldIndices.map((fi) =>
          fs.writeFile(path.join(fieldsDir, `PerfField${String(fi).padStart(3, '0')}__c.field-meta.xml`), fieldXml(fi))
        ),
      ]);
    }, Promise.resolve());

    const allFiles = await walkAllFiles(path.join(ctx.projectPath, 'force-app'));
    ctx.elements = allFiles.map(buildInput(ctx.projectPath));
    ctx.statsPath = path.join(os.tmpdir(), 'stl-perf-stats.jsonl');
  });

  after(async () => {
    if (ctx.projectPath && process.env.STL_PERF_KEEP !== '1') {
      await fs.rm(ctx.projectPath, { recursive: true, force: true });
    }
  });

  it(`effect: measures ${OBJECT_COUNT}x${FIELDS_PER_OBJECT} synthetic objects`, async function () {
    this.timeout(120_000);
    const { layer, spanFilePath } = PerfNutSdkLayer(`objects-${OBJECT_COUNT}x${FIELDS_PER_OBJECT}-effect`);
    const { result, stats } = await populateTypesAndNamesEffect({ projectPath: ctx.projectPath, registry })(
      ctx.elements
    ).pipe(measure, Effect.provide(layer), Effect.runPromise);
    const row: RunStats = {
      variant: 'effect',
      fixture: `objects-${OBJECT_COUNT}x${FIELDS_PER_OBJECT}`,
      inputElements: ctx.elements.length,
      resultElements: result.length,
      ...stats,
    };
    await writeStats(ctx.statsPath, row);
    logRow(row, spanFilePath);
    expect(result).to.have.length(OBJECT_COUNT * (FIELDS_PER_OBJECT + 1));
    expect(result.filter((r) => r.name && r.type === 'CustomObject')).to.have.length(ctx.elements.length);
    expect(new Set(result.map(({ name }) => name)).size).to.equal(OBJECT_COUNT);
    expectWithinBudget(stats);
  });
});
