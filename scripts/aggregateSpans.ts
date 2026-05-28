/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Reads JSONL span files from a directory (default: ~/.sf/source-tracking-spans)
 * and emits a markdown summary of ShadowRepo.* spans grouped by name.
 *
 * Usage:
 *   ts-node scripts/aggregateSpans.ts <out.md> [spansDir]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Span = {
  name: string;
  durationMs: number;
  attributes: Record<string, string>;
};

const [, , outFile, dirArg] = process.argv;
if (!outFile) {
  // eslint-disable-next-line no-console
  console.error('usage: aggregateSpans.ts <out.md> [spansDir]');
  process.exit(1);
}

const dir = dirArg ?? join(process.env.HOME ?? '/tmp', '.sf', 'source-tracking-spans');

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

const spans: Span[] = files.flatMap((f) =>
  readFileSync(join(dir, f), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Span)
    .filter((s) => s.name.startsWith('ShadowRepo.') || s.name === 'populateTypesAndNames')
);

const byName = new Map<string, Span[]>();
spans.forEach((s) => byName.set(s.name, (byName.get(s.name) ?? []).concat(s)));

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const num = (v: string | undefined): number => (v === undefined ? NaN : Number(v));
const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '');

const summarize = (name: string, ss: Span[]): string => {
  const durs = ss.map((s) => s.durationMs).sort((a, b) => a - b);
  const total = durs.reduce((a, b) => a + b, 0);
  const rowCounts = ss.map((s) => num(s.attributes.rowCount)).filter(Number.isFinite);
  const maxRows = rowCounts.length ? Math.max(...rowCounts) : 0;
  const elMax = ss.map((s) => num(s.attributes.elMaxMs)).filter(Number.isFinite);
  const maxElMax = elMax.length ? Math.max(...elMax) : NaN;
  return [
    `### ${name}`,
    '',
    `- count: ${ss.length}`,
    `- total: ${total.toFixed(1)} ms`,
    `- min / p50 / p90 / p99 / max: ${durs[0].toFixed(1)} / ${pct(durs, 50).toFixed(1)} / ${pct(durs, 90).toFixed(
      1
    )} / ${pct(durs, 99).toFixed(1)} / ${durs[durs.length - 1].toFixed(1)} ms`,
    rowCounts.length ? `- max rowCount observed: ${maxRows.toLocaleString()}` : '',
    Number.isFinite(maxElMax) ? `- worst event-loop block (elMaxMs across all calls): ${maxElMax.toFixed(1)} ms` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
};

const longestPerName = (name: string, ss: Span[]): string => {
  const top = [...ss].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  const rows = top
    .map(
      (s) =>
        `| ${s.durationMs.toFixed(1)} | ${s.attributes.rowCount ?? ''} | ${s.attributes.noCache ?? ''} | ${
          s.attributes.packageDirCount ?? ''
        } | ${s.attributes.deployedCount ?? ''} | ${s.attributes.deletedCount ?? ''} | ${fmt(
          num(s.attributes.elP50Ms)
        )} | ${fmt(num(s.attributes.elP99Ms))} | ${fmt(num(s.attributes.elMaxMs))} |`
    )
    .join('\n');
  return [
    `#### longest ${name} calls`,
    '',
    '| durationMs | rowCount | noCache | pkgDirs | deployed | deleted | elP50ms | elP99ms | elMaxMs |',
    '|---:|---:|:---|---:|---:|---:|---:|---:|---:|',
    rows,
    '',
  ].join('\n');
};

const md = [
  '# ShadowRepo span baseline',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Source dir: \`${dir}\``,
  `Files: ${files.length}`,
  `Total ShadowRepo spans: ${spans.length}`,
  '',
  '## Summary',
  '',
  ...[...byName.keys()]
    .sort()
    .flatMap((name) => [summarize(name, byName.get(name)!), longestPerName(name, byName.get(name)!)]),
].join('\n');

writeFileSync(outFile, md);
// eslint-disable-next-line no-console
console.log(`wrote ${outFile} (${spans.length} spans across ${files.length} files)`);
