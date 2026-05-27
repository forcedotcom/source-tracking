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
 * NodeSdk.layer wiring for the perf NUT. Library code (src/) does NOT
 * configure the OTel SDK; consumers do. The perf NUT is one such consumer.
 */
import { NodeSdk } from '@effect/opentelemetry';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { FileSpanExporterNode } from './fileSpanExporterNode';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const PerfNutSdkLayer = (label: string) => {
  const exporter = new FileSpanExporterNode(label);
  return {
    layer: NodeSdk.layer(() => ({
      resource: { serviceName: 'source-tracking-perf' },
      spanProcessor: [new SimpleSpanProcessor(exporter)],
    })),
    spanFilePath: exporter.path,
  };
};
