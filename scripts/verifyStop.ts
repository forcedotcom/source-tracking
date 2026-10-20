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
import { spawn } from 'node:child_process';

type Step = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
};

type CommandResult = {
  readonly ok: boolean;
  readonly output: string;
};

export type RunCommand = (args: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}) => Promise<CommandResult>;

const STEPS: readonly Step[] = [
  { name: 'compile', command: 'yarn', args: ['compile'] },
  { name: 'lint', command: 'yarn', args: ['lint'] },
  { name: 'test', command: 'yarn', args: ['test:only'] },
  { name: 'knip', command: 'yarn', args: ['knip'] },
];

const runCommand: RunCommand = ({ command, args, cwd }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: process.platform === 'win32' });
    const output: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));
    child.on('error', (error) => resolve({ ok: false, output: String(error) }));
    child.on('close', (code) => resolve({ ok: code === 0, output: Buffer.concat(output).toString() }));
  });

export const verifyStop = async (root: string, run: RunCommand = runCommand) => {
  for (const step of STEPS) {
    const result = await run({ command: step.command, args: step.args, cwd: root });
    if (!result.ok) return { ...result, step: step.name };
  }
  return { ok: true, output: '', step: 'stop verification' };
};

export const formatStopFailure = (result: Awaited<ReturnType<typeof verifyStop>>): string | undefined =>
  result.ok
    ? undefined
    : `Verification failed: ${result.step}. Fix the errors before ending the session:\n${result.output}`;

const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch']);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const eventData = (event: unknown): Record<string, unknown> | undefined => {
  const data = asObject(event);
  return asObject(data?.data) ?? asObject(data?.properties) ?? data;
};

export const isIdleEvent = (event: unknown): boolean => {
  const data = asObject(event);
  if (data?.type === 'session.idle') return true;
  if (data?.type !== 'session.status') return false;
  const status = eventData(event)?.status;
  return (typeof status === 'string' ? status : asObject(status)?.type) === 'idle';
};

export const createStopVerificationHooks = (
  session: { prompt: (args: { sessionID: string; text: string }) => Promise<unknown> },
  root: string,
  run: RunCommand = runCommand
) => {
  const dirty = new Set<string>();
  const verifying = new Set<string>();
  const continuationIssued = new Set<string>();
  const versions = new Map<string, number>();

  const afterTool = (event: unknown): void => {
    const data = asObject(event);
    const sessionID = data?.sessionID;
    const tool = data?.tool;
    if (data?.status !== 'completed' || typeof tool !== 'string' || !EDIT_TOOLS.has(tool)) return;
    if (typeof sessionID !== 'string' || sessionID.length === 0) return;
    dirty.add(sessionID);
    versions.set(sessionID, (versions.get(sessionID) ?? 0) + 1);
    continuationIssued.delete(sessionID);
  };

  const onIdle = async (event: unknown): Promise<void> => {
    if (!isIdleEvent(event)) return;
    const sessionIDValue = eventData(event)?.sessionID ?? asObject(event)?.sessionID;
    if (typeof sessionIDValue !== 'string' || sessionIDValue.length === 0) return;
    const sessionID = sessionIDValue;
    if (!dirty.has(sessionID) || verifying.has(sessionID) || continuationIssued.has(sessionID)) return;

    verifying.add(sessionID);
    const verifiedVersion = versions.get(sessionID) ?? 0;
    try {
      const message = formatStopFailure(await verifyStop(root, run));
      if (!message && versions.get(sessionID) === verifiedVersion) dirty.delete(sessionID);
      if (!message) return;
      continuationIssued.add(sessionID);
      await session.prompt({
        sessionID,
        text: `${message}\nContinue in this session: fix the failure, then complete the task.`,
      });
    } catch (error) {
      continuationIssued.delete(sessionID);
      throw error;
    } finally {
      verifying.delete(sessionID);
    }
  };

  return { afterTool, onIdle };
};

export const runStopEventLoop = async ({
  events,
  onIdle,
  reportError,
  signal,
}: {
  readonly events: AsyncIterable<unknown>;
  readonly onIdle: (event: unknown) => Promise<void>;
  readonly reportError: (message: string, error: unknown) => void;
  readonly signal?: AbortSignal;
}) => {
  const pending = new Set<Promise<void>>();
  try {
    for await (const event of events) {
      const verification = onIdle(event)
        .catch((error) => reportError('Stop verification failed', error))
        .finally(() => pending.delete(verification));
      pending.add(verification);
    }
  } catch (error) {
    if (!signal?.aborted) reportError('Event subscription failed', error);
  }
  await Promise.allSettled(pending);
};
