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
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { NodeSdk } from '@effect/opentelemetry';
import { SimpleSpanProcessor, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
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

const buildOtelLayer = (): Layer.Layer<never> => {
  const dir = process.env.STL_OTEL_DIR ?? join(process.env.HOME ?? '/tmp', '.sf', 'source-tracking-spans');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `spans-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}.jsonl`);
  // eslint-disable-next-line no-console
  console.log(`[STL_OTEL_SPANS] writing spans to ${filePath}`);
  const exporter = new JsonlFileExporter(filePath);
  return NodeSdk.layer(() => ({
    resource: { serviceName: 'source-tracking' },
    spanProcessor: [new SimpleSpanProcessor(exporter)],
  })) as unknown as Layer.Layer<never>;
};

const runtime = ManagedRuntime.make(process.env.STL_OTEL_SPANS === '1' ? buildOtelLayer() : Layer.empty);

/**
 * `runtime.runPromise` rejects with `FiberFailure` for both typed failures and
 * defects, breaking callers that branch on `e instanceof SfError` or read
 * `e.name`. This helper runs the effect and rejects with the original
 * underlying error so legacy throw semantics are preserved.
 */
export const runPromise = async <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => {
  const exit = await runtime.runPromiseExit(eff);
  if (Exit.isSuccess(exit)) return exit.value;
  const fail = Cause.failureOption(exit.cause);
  if (Option.isSome(fail)) throw fail.value;
  const die = Cause.dieOption(exit.cause);
  if (Option.isSome(die)) throw die.value;
  throw Cause.squash(exit.cause);
};
