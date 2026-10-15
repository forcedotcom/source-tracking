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
import { expect } from 'chai';
import {
  createStopVerificationHooks,
  formatStopFailure,
  isIdleEvent,
  verifyStop,
  type RunCommand,
} from '../../scripts/verifyStop.js';

describe('OpenCode stop verification', () => {
  it('runs the same verification steps in order and stops at the first failure', async () => {
    const calls: string[] = [];
    const run: RunCommand = ({ command, args }) => {
      const name = `${command} ${args.join(' ')}`;
      calls.push(name);
      return Promise.resolve({ ok: command !== 'yarn' || args[0] !== 'lint', output: name });
    };

    const result = await verifyStop('/repo', run);
    expect(calls).to.deep.equal(['yarn compile', 'yarn lint']);
    expect(result).to.deep.equal({ ok: false, output: 'yarn lint', step: 'lint' });
    expect(formatStopFailure(result)).to.include('Verification failed: lint');
  });

  it('runs once on idle after successful edits and skips clean sessions', async () => {
    const calls: string[] = [];
    const prompts: unknown[] = [];
    const hooks = createStopVerificationHooks(
      { prompt: (args) => Promise.resolve(void prompts.push(args)) },
      '/repo',
      ({ command, args }) => {
        calls.push(`${command} ${args.join(' ')}`);
        return Promise.resolve({ ok: true, output: '' });
      }
    );

    hooks.afterTool({ status: 'completed', tool: 'edit', sessionID: 'dirty' });
    await hooks.onIdle({ type: 'session.status', data: { sessionID: 'dirty', status: { type: 'idle' } } });
    await hooks.onIdle({ type: 'session.idle', data: { sessionID: 'dirty' } });
    await hooks.onIdle({ type: 'session.idle', data: { sessionID: 'clean' } });

    expect(calls).to.have.lengthOf(4);
    expect(prompts).to.have.lengthOf(0);
  });

  it('prompts the same session to continue when verification fails', async () => {
    const prompts: Array<{ sessionID: string; text: string }> = [];
    const hooks = createStopVerificationHooks(
      { prompt: (args) => Promise.resolve(void prompts.push(args)) },
      '/repo',
      () => Promise.resolve({ ok: false, step: 'compile', output: 'Type error' })
    );

    hooks.afterTool({ status: 'completed', tool: 'write', sessionID: 's1' });
    await hooks.onIdle({ type: 'session.idle', data: { sessionID: 's1' } });
    await hooks.onIdle({ type: 'session.idle', data: { sessionID: 's1' } });

    expect(prompts).to.have.lengthOf(1);
    expect(prompts[0]?.sessionID).to.equal('s1');
    expect(prompts[0]?.text).to.include('Type error');
  });

  it('only treats completed edit tools as changes', () => {
    let calls = 0;
    const hooks = createStopVerificationHooks({ prompt: () => Promise.resolve(undefined) }, '/repo', () => {
      calls += 1;
      return Promise.resolve({ ok: true, output: '' });
    });

    hooks.afterTool({ status: 'failed', tool: 'edit', sessionID: 's1' });
    hooks.afterTool({ status: 'completed', tool: 'read', sessionID: 's1' });
    expect(isIdleEvent({ type: 'message.updated' })).to.equal(false);
    return hooks.onIdle({ type: 'session.idle', data: { sessionID: 's1' } }).then(() => {
      expect(calls).to.equal(0);
    });
  });
});
