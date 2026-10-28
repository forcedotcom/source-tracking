require('ts-node/register');

const { withTrackingLock } = require('../../src/shared/trackingLock');

const [projectPath, orgId, resource] = process.argv.slice(2);

withTrackingLock({ projectPath, orgId, resource }, async () => {
  process.stdout.write('locked\n');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
