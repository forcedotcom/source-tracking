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
import { spawn } from 'node:child_process';
import { expect } from 'chai';
import { TrackingLockTimeoutError, withTrackingLock } from '../../src/shared/trackingLock';

describe('tracking lock', () => {
  let projectPath: string;
  const options = () => ({ projectPath, orgId: '00D000000000001', resource: 'local' as const });

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracking-lock-'));
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('serializes overlapping operations for the same project, org, and resource', async () => {
    let releaseFirst: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = withTrackingLock(options(), async () => {
      events.push('first-start');
      await firstCanFinish;
      events.push('first-finish');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withTrackingLock(options(), async () => {
      events.push('second-start');
      events.push('second-finish');
    });

    expect(events).to.deep.equal(['first-start']);
    releaseFirst!();
    await Promise.all([first, second]);
    expect(events).to.deep.equal(['first-start', 'first-finish', 'second-start', 'second-finish']);
  });

  it('releases after a failed operation', async () => {
    let error: unknown;
    try {
      await withTrackingLock(options(), async () => {
        throw new Error('expected failure');
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal('expected failure');

    await withTrackingLock(options(), async () => undefined);
  });

  it('does not take over an existing lock directory', async () => {
    const staleLock = path.join(projectPath, '.sf', 'orgs', '00D000000000001', 'sourceTrackingLocks', 'local.lock');
    await fs.mkdir(staleLock, { recursive: true });
    await fs.writeFile(path.join(staleLock, 'owner'), 'stale-owner');
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(staleLock, staleTime, staleTime);

    let error: unknown;
    try {
      await withTrackingLock({ ...options(), timeoutMs: 1 }, async () => undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(TrackingLockTimeoutError);
  });

  it('does not remove a lock directory whose owner token changed', async () => {
    const staleLock = path.join(projectPath, '.sf', 'orgs', '00D000000000001', 'sourceTrackingLocks', 'local.lock');
    await fs.mkdir(staleLock, { recursive: true });
    await fs.writeFile(path.join(staleLock, 'owner'), 'stale-owner');
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(staleLock, staleTime, staleTime);

    await fs.rm(staleLock, { recursive: true });
    await withTrackingLock(options(), async () => {
      await fs.rm(staleLock, { recursive: true });
      await fs.mkdir(staleLock, { recursive: true });
      await fs.writeFile(path.join(staleLock, 'owner'), 'new-owner');
    });

    expect(await fs.readFile(path.join(staleLock, 'owner'), 'utf8')).to.equal('new-owner');
  });

  it('times out rather than entering a held fresh lock', async () => {
    const heldLock = path.join(projectPath, '.sf', 'orgs', '00D000000000001', 'sourceTrackingLocks', 'local.lock');
    await fs.mkdir(heldLock, { recursive: true });

    let error: unknown;
    try {
      await withTrackingLock({ ...options(), timeoutMs: 1 }, async () => undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(TrackingLockTimeoutError);
  });

  it('serializes across processes', async () => {
    const holder = spawn(process.execPath, [
      path.join(__dirname, '..', 'fixtures', 'trackingLockHolder.js'),
      projectPath,
      '00D000000000001',
      'local',
    ]);
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', (output: Buffer) => {
        if (output.toString() === 'locked\n') resolve();
        else reject(new Error(`Unexpected lock holder output: ${output.toString()}`));
      });
    });

    let error: unknown;
    try {
      await withTrackingLock({ ...options(), timeoutMs: 100 }, async () => undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(TrackingLockTimeoutError);

    const exitCode = await new Promise<number | null>((resolve) => holder.once('exit', resolve));
    expect(exitCode).to.equal(0);
    await withTrackingLock(options(), async () => undefined);
  });
});
