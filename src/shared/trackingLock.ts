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
import fs from 'graceful-fs';

const RETRY_DELAY_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const OWNER_FILE = 'owner';

export class TrackingLockTimeoutError extends Error {
  public constructor(public readonly lockPath: string, public readonly timeoutMs: number) {
    super(`Timed out acquiring source tracking lock ${lockPath} after ${timeoutMs}ms`);
    this.name = 'TrackingLockTimeoutError';
  }
}

type LockOptions = {
  projectPath: string;
  orgId: string;
  resource: 'local' | 'remote';
  timeoutMs?: number;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const lockPathFrom = ({ projectPath, orgId, resource }: LockOptions): string =>
  path.join(projectPath, '.sf', 'orgs', orgId, 'sourceTrackingLocks', `${resource}.lock`);

const ownerPath = (lockPath: string): string => path.join(lockPath, OWNER_FILE);

const createOwner = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const release = async (lockPath: string, owner?: string): Promise<void> => {
  if (owner) {
    const currentOwner = await fs.promises
      .readFile(ownerPath(lockPath), 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
    // A stale-recovery contender acquired the directory after this owner lost it.
    if (currentOwner !== owner) return;
    await fs.promises.unlink(ownerPath(lockPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await (owner ? fs.promises.rmdir(lockPath) : fs.promises.rm(lockPath, { recursive: true, force: true })).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    }
  );
};

const acquire = async (lockPath: string, timeoutMs: number): Promise<string> => {
  const startedAt = Date.now();
  const owner = createOwner();
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.mkdir(lockPath);
      // The token prevents a prior owner from removing a lock after stale recovery.
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.writeFile(ownerPath(lockPath), owner, 'utf8');
      return owner;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    if (Date.now() - startedAt >= timeoutMs) throw new TrackingLockTimeoutError(lockPath, timeoutMs);
    // eslint-disable-next-line no-await-in-loop
    await wait(RETRY_DELAY_MS);
  }
};

/**
 * Serializes cooperating STL operations for one project, org, and tracking
 * resource. The directory-create protocol works with Node fs and ICD's memfs.
 *
 * Automatic stale-lock deletion is intentionally unsupported: portable
 * filesystem APIs lack a compare-and-swap operation that can prove the holder
 * observed as stale is still the holder being removed.
 */
export const withTrackingLock = async <T>(options: LockOptions, operation: () => Promise<T>): Promise<T> => {
  const lockPath = lockPathFrom(options);
  const owner = await acquire(lockPath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await operation();
  } finally {
    await release(lockPath, owner);
  }
};
