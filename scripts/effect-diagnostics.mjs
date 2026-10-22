import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'node_modules', '@effect', 'language-service', 'cli.js');
const configPath = path.join(repoRoot, 'config', 'effect-diagnostics.json');
const enforcedRules = JSON.parse(readFileSync(configPath, 'utf8')).enforcedRules;

if (!Array.isArray(enforcedRules)) {
  console.error('config/effect-diagnostics.json: "enforcedRules" must be an array');
  process.exit(1);
}

const enforcedSet = new Set(enforcedRules);
const projects = ['tsconfig.json', 'test/tsconfig.json'].map((project) => ({
  name: project,
  tsconfig: path.join(repoRoot, project),
}));

const results = projects.map(({ name, tsconfig }) => {
  if (!existsSync(tsconfig)) return { name, skipped: true, detail: 'project config not found' };

  const result = spawnSync(process.execPath, [cli, 'diagnostics', '--project', tsconfig, '--format', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });

  try {
    const output = JSON.parse(result.stdout);
    return output.summary?.filesChecked > 0
      ? { name, diagnostics: output.diagnostics ?? [] }
      : { name, failed: true, detail: 'Effect diagnostics checked 0 files' };
  } catch {
    const detail = (result.stderr || result.stdout || '').trim();
    return detail.includes('NoFilesToCheckError')
      ? { name, skipped: true, detail: detail.split('\n')[0] }
      : {
          name,
          failed: true,
          detail: detail || (result.error ? result.error.code ?? result.error.message : `exit ${result.status}`),
        };
  }
});

const skipped = results.filter((result) => result.skipped);
const failed = results.filter((result) => result.failed);
const violations = results
  .filter((result) => !result.skipped && !result.failed)
  .flatMap((result) => result.diagnostics.filter((diagnostic) => enforcedSet.has(diagnostic.name)));
const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';

skipped.forEach((result) => console.log(`skip ${result.name}: ${result.detail}`));
failed.forEach((result) =>
  console.log(
    isGitHubActions
      ? `::error::effect-diagnostics failed to run on ${result.name}: ${result.detail}`
      : `FAIL ${result.name}: ${result.detail}`
  )
);
violations.forEach((diagnostic) =>
  console.log(
    isGitHubActions
      ? `::error file=${diagnostic.file},line=${diagnostic.line},col=${diagnostic.column}::${diagnostic.name} ${diagnostic.message}`
      : `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.name} - ${diagnostic.message}`
  )
);

console.log(`${enforcedRules.length} v4 rules enforced`);
console.log(
  `${results.length - skipped.length - failed.length} projects checked, ${skipped.length} skipped, ${
    failed.length
  } failed, ${violations.length} enforced violation(s)`
);
process.exit(failed.length > 0 || violations.length > 0 ? 1 : 0);
