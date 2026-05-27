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
 * Vendored from salesforcedx-vscode/packages/salesforcedx-vscode-services/src/observability/{fileSpanExporterNode,spanUtils}.ts
 * to keep source-tracking decoupled from any otel SDK ownership. Used only by the perf NUT.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/member-ordering, header/header */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Attributes, SpanStatusCode } from '@opentelemetry/api';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Global } from '@salesforce/core/global';

const SPANS_DIR = join(Global.SF_DIR, 'source-tracking-spans');

const spanDuration = (span: ReadableSpan): number =>
  span.duration ? span.duration[0] * 1000 + span.duration[1] / 1_000_000 : 0;

const convertAttributes = (attributes: Attributes): Attributes =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );

const serializeSpanForFile = (span: ReadableSpan): string =>
  JSON.stringify({
    name: span.name,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? '',
    durationMs: spanDuration(span),
    status: span.status?.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
    startTime: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1_000_000).toISOString(),
    attributes: convertAttributes(span.attributes),
  });

/** Span exporter that appends simplified JSON lines to ~/.sf/source-tracking-spans/{label}-{timestamp}.jsonl */
export class FileSpanExporterNode implements SpanExporter {
  private readonly filePath: string;

  public constructor(label: string) {
    mkdirSync(SPANS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    this.filePath = join(SPANS_DIR, `${label}-${timestamp}.jsonl`);
  }

  public export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const lines = spans.map(serializeSpanForFile).join('\n') + (spans.length > 0 ? '\n' : '');
    if (!lines) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    const result: ExportResult = (() => {
      // eslint-disable-next-line functional/no-try-statements -- sync fs op, no Effect in exporter
      try {
        appendFileSync(this.filePath, lines);
        return { code: ExportResultCode.SUCCESS };
      } catch (error) {
        return { code: ExportResultCode.FAILED, error: error as Error };
      }
    })();
    resultCallback(result);
  }

  public get path(): string {
    return this.filePath;
  }

  // eslint-disable-next-line class-methods-use-this -- SpanExporter interface requires shutdown
  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
