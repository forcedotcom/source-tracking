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
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { NodeSdk } from '@effect/opentelemetry';
import { BatchSpanProcessor, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { type Attributes, SpanStatusCode } from '@opentelemetry/api';

/**
 * Shared module-level ManagedRuntime so every `runPromise` in src/ executes
 * on the same fiber/runtime instead of paying ManagedRuntime/Runtime
 * construction cost per call. Library code provides no services by default.
 *
 * When STL_OTEL_SPANS=1, attach a NodeSdk Layer that writes spans to
 * `${STL_OTEL_DIR ?? ~/.sf/source-tracking-spans}/spans-{timestamp}.jsonl`.
 * Used to capture baselines from the existing NUT suite without modifying NUTs.
 */

const spanDuration = (s: ReadableSpan): number => (s.duration ? s.duration[0] * 1000 + s.duration[1] / 1_000_000 : 0);

const stringifyAttrs = (attrs: Attributes): Attributes =>
  Object.fromEntries(
    Object.entries(attrs)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)])
  );

const serialize = (s: ReadableSpan): string =>
  JSON.stringify({
    name: s.name,
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanContext?.spanId ?? '',
    durationMs: spanDuration(s),
    status: s.status?.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
    // @effect-diagnostics-next-line globalDate:off
    startTime: new Date(s.startTime[0] * 1000 + s.startTime[1] / 1_000_000).toISOString(),
    attributes: stringifyAttrs(s.attributes),
  });

class JsonlFileExporter implements SpanExporter {
  public constructor(private readonly filePath: string) {}

  public export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    if (spans.length === 0) return cb({ code: ExportResultCode.SUCCESS });
    const lines = spans.map(serialize).join('\n') + '\n';
    // eslint-disable-next-line functional/no-try-statements
    try {
      appendFileSync(this.filePath, lines);
      cb({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      cb({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  // eslint-disable-next-line class-methods-use-this
  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Build the OTel layer that writes spans to a jsonl file. Active iff
 * `STL_OTEL_SPANS=1`; otherwise returns `Layer.empty` so callers can use
 * the same factory unconditionally.
 *
 * Exported so the lite shadow's ManagedRuntime can compose it too —
 * otherwise spans inside lite operations don't make it to the file.
 */
export const otelLayerOrEmpty = (): Layer.Layer<never> => {
  if (process.env.STL_OTEL_SPANS !== '1') return Layer.empty;
  const dir = process.env.STL_OTEL_DIR ?? join(process.env.HOME ?? '/tmp', '.sf', 'source-tracking-spans');
  mkdirSync(dir, { recursive: true });
  // @effect-diagnostics-next-line globalDate:off
  const filePath = join(dir, `spans-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}.jsonl`);
  // @effect-diagnostics-next-line globalConsole:off
  console.log(`[STL_OTEL_SPANS] writing spans to ${filePath}`); // eslint-disable-line no-console
  const exporter = new JsonlFileExporter(filePath);
  return NodeSdk.layer(() => ({
    resource: { serviceName: 'source-tracking' },
    // Batch instead of Simple: Simple calls `export()` per span, so under
    // a high-volume workload (e.g. 200k stageAdd spans) the per-span
    // appendFileSync becomes the dominant cost. Batch buffers and flushes
    // in chunks per the OTel JS guidance on span processors.
    spanProcessor: [new BatchSpanProcessor(exporter)],
  }));
};

const runtime = ManagedRuntime.make(otelLayerOrEmpty());

/**
 * `runtime.runPromise` rejects with `FiberFailure` for both typed failures and
 * defects, breaking callers that branch on `e instanceof SfError` or read
 * `e.name`. This helper runs the effect and rejects with the original
 * underlying error so legacy throw semantics are preserved.
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
