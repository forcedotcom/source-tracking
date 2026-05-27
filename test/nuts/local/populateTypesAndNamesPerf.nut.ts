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
 * Measures the current implementation against two fixtures (EDA + 35k generated
 * object/field files). Captures wall-clock + perf_hooks event-loop-delay
 * histogram per run. Writes per-run JSONL to the test session's directory.
 *
 * Effect-translated variants (resolve-then-claim, vanilla-vs-HashMap dedup,
 * throttle-lever sweeps) get layered on by subsequent commits in this PR.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { monitorEventLoopDelay, performance, IntervalHistogram } from 'node:perf_hooks';
import { expect } from 'chai';
import * as Effect from 'effect/Effect';
import { RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { populateTypesAndNamesLegacy } from '../../../src/shared/populateTypesAndNamesLegacy';
import { populateTypesAndNames as populateTypesAndNamesEffect } from '../../../src/shared/populateTypesAndNames';
import { ChangeResult } from '../../../src/shared/types';
import { PerfNutSdkLayer } from '../../perf-utils/sdkLayer';

type RunStats = {
  readonly variant: string;
  readonly fixture: string;
  readonly inputElements: number;
  readonly resultElements: number;
  readonly wallMs: number;
  readonly elP50Ms: number;
  readonly elP99Ms: number;
  readonly elMaxMs: number;
};

const ns = (h: IntervalHistogram, p: number) => h.percentile(p) / 1_000_000;

const measure = async <T>(
  fn: () => Promise<T> | T
): Promise<{ result: T; stats: Omit<RunStats, 'variant' | 'fixture' | 'inputElements' | 'resultElements'> }> => {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  // ensure histogram's internal sampler is registered before our work starts
  await new Promise<void>((r) => setImmediate(r));
  const start = performance.now();
  const result = await fn();
  const wallMs = performance.now() - start;
  // give the sampler one more tick to record any block that finished before its timer fired
  await new Promise<void>((r) => setImmediate(r));
  histogram.disable();
  return {
    result,
    stats: {
      wallMs,
      elP50Ms: ns(histogram, 50),
      elP99Ms: ns(histogram, 99),
      elMaxMs: histogram.max / 1_000_000,
    },
  };
};

const writeStats = async (file: string, line: RunStats) => fs.appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');

const logRow = (row: RunStats, extra?: string) => {
  // eslint-disable-next-line no-console
  console.log(
    `[perf] ${row.fixture} ${row.variant} input=${row.inputElements} result=${
      row.resultElements
    } wall=${row.wallMs.toFixed(1)}ms el-p99=${row.elP99Ms.toFixed(1)}ms el-max=${row.elMaxMs.toFixed(1)}ms${
      extra ? ` extra=${extra}` : ''
    }`
  );
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
  execSync(`git clone --depth 1 https://github.com/SalesforceFoundation/EDA "${target}"`, { stdio: 'ignore' });
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

  it(`baseline: legacy populateTypesAndNames on ${process.env.STL_PERF_LABEL ?? 'EDA'}`, async () => {
    const { result, stats } = await measure(() =>
      populateTypesAndNamesLegacy({ projectPath: ctx.projectPath, registry })(ctx.elements)
    );
    const row: RunStats = {
      variant: 'legacy',
      fixture: 'EDA',
      inputElements: ctx.elements.length,
      resultElements: result.length,
      ...stats,
    };
    await writeStats(ctx.statsPath, row);
    logRow(row);
    expect(result.filter((r) => r.name && r.type).length).to.be.greaterThan(0);
  });

  it('effect: matches legacy on EDA', async () => {
    const { layer, spanFilePath } = PerfNutSdkLayer('eda-effect');
    const { result, stats } = await measure(() =>
      Effect.runPromise(
        populateTypesAndNamesEffect({ projectPath: ctx.projectPath, registry })(ctx.elements).pipe(
          Effect.provide(layer)
        )
      )
    );
    const legacy = populateTypesAndNamesLegacy({ projectPath: ctx.projectPath, registry })(ctx.elements);
    const row: RunStats = {
      variant: 'effect',
      fixture: 'EDA',
      inputElements: ctx.elements.length,
      resultElements: result.length,
      ...stats,
    };
    await writeStats(ctx.statsPath, row);
    logRow(row, spanFilePath);
    expect(result.length).to.equal(legacy.length);
    const legacyResolved = legacy.filter((r) => r.name && r.type).length;
    const effectResolved = result.filter((r) => r.name && r.type).length;
    expect(effectResolved).to.equal(legacyResolved);
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

  it(`baseline: legacy populateTypesAndNames on ${OBJECT_COUNT}x${FIELDS_PER_OBJECT}`, async function () {
    this.timeout(120_000);
    const { result, stats } = await measure(() =>
      populateTypesAndNamesLegacy({ projectPath: ctx.projectPath, registry })(ctx.elements)
    );
    const row: RunStats = {
      variant: 'legacy',
      fixture: `objects-${OBJECT_COUNT}x${FIELDS_PER_OBJECT}`,
      inputElements: ctx.elements.length,
      resultElements: result.length,
      ...stats,
    };
    await writeStats(ctx.statsPath, row);
    logRow(row, ctx.statsPath);
    expect(result.filter((r) => r.name && r.type).length).to.be.greaterThan(0);
  });

  it(`effect: matches legacy on ${OBJECT_COUNT}x${FIELDS_PER_OBJECT}`, async function () {
    this.timeout(120_000);
    const { layer, spanFilePath } = PerfNutSdkLayer(`objects-${OBJECT_COUNT}x${FIELDS_PER_OBJECT}-effect`);
    const { result, stats } = await measure(() =>
      Effect.runPromise(
        populateTypesAndNamesEffect({ projectPath: ctx.projectPath, registry })(ctx.elements).pipe(
          Effect.provide(layer)
        )
      )
    );
    const legacy = populateTypesAndNamesLegacy({ projectPath: ctx.projectPath, registry })(ctx.elements);
    const row: RunStats = {
      variant: 'effect',
      fixture: `objects-${OBJECT_COUNT}x${FIELDS_PER_OBJECT}`,
      inputElements: ctx.elements.length,
      resultElements: result.length,
      ...stats,
    };
    await writeStats(ctx.statsPath, row);
    logRow(row, spanFilePath);
    expect(result.length).to.equal(legacy.length);
    const legacyResolved = legacy.filter((r) => r.name && r.type).length;
    const effectResolved = result.filter((r) => r.name && r.type).length;
    expect(effectResolved).to.equal(legacyResolved);
  });
});
