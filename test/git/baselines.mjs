#!/usr/bin/env node
// Capture iso-git baseline numbers used by phase 0 of the src/git/ migration.
// Outputs JSON to stdout; the runner script writes that JSON to baselines.json.
//
// Why a synthetic project (not perf-tracking-bug):
//   - perf-tracking-bug ships a real VSCode/Playwright harness; not portable
//     across dev machines and not appropriate for a CI-friendly script.
//   - We synthesize an SFDX-shaped project (deeply nested CustomObject + fields)
//     sized to the same order of magnitude (~37k files). The shape — not the
//     exact contents — is what stresses statusMatrix.
//
// Usage:
//   node test/git/baselines.mjs [--files=37000] [--apply=50000] [--keep]
//
// Pass --keep to leave the temp project on disk for inspection.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import git from 'isomorphic-git';
import gracefulFs from 'graceful-fs';

const argv = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => arg.replace(/^--/, '').split('='))
    .map(([key, value = 'true']) => [key, value])
);

const STATUS_FILE_COUNT = Number(argv.files ?? 37_000);
const APPLY_FILE_COUNT = Number(argv.apply ?? 50_000);
const KEEP = argv.keep === 'true';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lite-baselines-'));
const dir = path.join(tmpRoot, 'project');
const gitdir = path.join(dir, '.sf', 'shadow', '.git');
await fs.mkdir(path.join(dir, 'force-app', 'main', 'default'), { recursive: true });
await fs.mkdir(gitdir, { recursive: true });

// Generate an SFDX-shaped tree: a CustomObject + a fan-out of fields + LWC
// bundles. Distribution chosen to land near STATUS_FILE_COUNT files.
const fieldsPerObject = 50;
const objects = Math.ceil(STATUS_FILE_COUNT / (fieldsPerObject + 1));
const objectsRoot = path.join(dir, 'force-app', 'main', 'default', 'objects');
await fs.mkdir(objectsRoot, { recursive: true });

let totalFiles = 0;
const drainBatch = 4096;
const drain = async (writes) => {
  for (let i = 0; i < writes.length; i += drainBatch) {
    await Promise.all(writes.slice(i, i + drainBatch));
  }
};
// First pass: create object dirs so subsequent writes never race their parent.
const objDirs = [];
for (let o = 0; o < objects; o++) {
  const objDir = path.join(objectsRoot, `Obj${o}__c`);
  objDirs.push({ objDir, fieldsDir: path.join(objDir, 'fields') });
}
await drain(objDirs.map(({ fieldsDir }) => fs.mkdir(fieldsDir, { recursive: true })));
// Second pass: write metadata files.
const writes = [];
for (let o = 0; o < objects; o++) {
  const { objDir, fieldsDir } = objDirs[o];
  writes.push(
    fs.writeFile(
      path.join(objDir, `Obj${o}__c.object-meta.xml`),
      `<?xml version="1.0"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"/>`
    )
  );
  totalFiles++;
  for (let f = 0; f < fieldsPerObject; f++) {
    if (totalFiles >= STATUS_FILE_COUNT) break;
    writes.push(
      fs.writeFile(
        path.join(fieldsDir, `Field${f}__c.field-meta.xml`),
        `<?xml version="1.0"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Field${f}__c</fullName></CustomField>`
      )
    );
    totalFiles++;
  }
}
await drain(writes);

const log = {};
log.fileCount = totalFiles;
log.objectCount = objects;
log.fieldsPerObject = fieldsPerObject;
log.timestamp = new Date().toISOString();
log.platform = process.platform;
log.arch = process.arch;
log.node = process.version;
log.cpu = os.cpus()[0]?.model;

await git.init({ fs: gracefulFs, dir, gitdir, defaultBranch: 'main' });

// Cold statusMatrix wall + event-loop delay.
{
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const t0 = performance.now();
  await git.statusMatrix({
    fs: gracefulFs,
    dir,
    gitdir,
    filepaths: ['force-app'],
  });
  const t1 = performance.now();
  histogram.disable();
  log.coldStatusMatrixMs = +(t1 - t0).toFixed(2);
  log.coldStatusMatrixEventLoopDelayMaxMs = +(histogram.max / 1e6).toFixed(2);
  log.coldStatusMatrixEventLoopDelayP99Ms = +(histogram.percentile(99) / 1e6).toFixed(2);
}

// applyChanges-equivalent: stage and commit `APPLY_FILE_COUNT` synthetic files.
// We add fresh files so we hit the add+commit path rather than a no-op.
{
  const stageDir = path.join(dir, 'apply-bench');
  await fs.mkdir(stageDir, { recursive: true });
  const stagePaths = [];
  const writes2 = [];
  for (let i = 0; i < APPLY_FILE_COUNT; i++) {
    const rel = path.join('apply-bench', `f${i}.txt`);
    stagePaths.push(rel);
    writes2.push(fs.writeFile(path.join(dir, rel), `content-${i}\n`));
  }
  await drain(writes2);
  const t0 = performance.now();
  // Match localShadowRepo's batched add (8K Win / 15K Unix).
  const batch = process.platform === 'win32' ? 8000 : 15000;
  for (let i = 0; i < stagePaths.length; i += batch) {
    await git.add({ fs: gracefulFs, dir, gitdir, filepath: stagePaths.slice(i, i + batch) });
  }
  await git.commit({
    fs: gracefulFs,
    dir,
    gitdir,
    message: 'apply-bench',
    author: { name: 'sfdx source tracking', email: 'source-tracking@noreply.salesforce.com' },
  });
  const t1 = performance.now();
  log.applyChanges50kMs = +(t1 - t0).toFixed(2);
  log.applyChangesFileCount = APPLY_FILE_COUNT;
}

if (!KEEP) {
  await fs.rm(tmpRoot, { recursive: true, force: true });
} else {
  log.keptAt = tmpRoot;
}

process.stdout.write(JSON.stringify(log, null, 2) + '\n');
