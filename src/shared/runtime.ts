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
import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as ManagedRuntime from 'effect/ManagedRuntime';

/**
 * Shared module-level ManagedRuntime so every `runPromise` in src/ executes
 * on the same fiber/runtime instead of paying ManagedRuntime/Runtime
 * construction cost per call. The library does not configure an OpenTelemetry
 * SDK; perf tests provide their own SDK layer when they need span export.
 */

const runtime = ManagedRuntime.make(Layer.empty);

/**
 * Promise boundary for Effects whose typed failures or defects may not be
 * `Error` instances. Preserve existing errors (including `SfError`) and wrap
 * non-Error causes so Promise callers can rely on Error rejection semantics.
 */
export const runPromise = async <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => {
  const exit = await runtime.runPromiseExit(eff);
  if (Exit.isSuccess(exit)) return exit.value;
  const fail = Cause.findErrorOption(exit.cause);
  if (Option.isSome(fail)) {
    if (fail.value instanceof Error) throw fail.value;
    throw new Error(String(fail.value), { cause: fail.value });
  }
  const die = Cause.findDefect(exit.cause);
  if (Result.isSuccess(die)) {
    if (die.success instanceof Error) throw die.success;
    throw new Error(String(die.success), { cause: die.success });
  }
  const squashed = Cause.squash(exit.cause);
  if (squashed instanceof Error) throw squashed;
  throw new Error(String(squashed), { cause: squashed });
};
