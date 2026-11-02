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
import { Plugin } from '@opencode/plugin';
import { createStopVerificationHooks, runStopEventLoop } from '../../scripts/verifyStop.ts';

export default Plugin.define({
  id: 'source-tracking.verify-stop',
  async setup(ctx) {
    const hooks = createStopVerificationHooks(ctx.session, ctx.location.directory);
    const toolHook = await ctx.tool.hook('execute.after', (event) => hooks.afterTool(event));
    const controller = new AbortController();
    const eventLoop = runStopEventLoop({
      events: ctx.event.subscribe({ signal: controller.signal }),
      onIdle: hooks.onIdle,
      reportError: (message, error) => console.error(`[verify-stop] ${message}`, error),
      signal: controller.signal,
    });

    return async () => {
      controller.abort();
      await Promise.all([eventLoop, toolHook.dispose()]);
    };
  },
});
