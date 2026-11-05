// Cloudflare may override wrangler.name with the Worker connected to this repo.
// Refuse another target before it can take the shared production domain.
const expected = 'contextation-offering';
const actual = process.env.WRANGLER_CI_OVERRIDE_NAME;
const workersBuild = ['1', 'true'].includes(process.env.WORKERS_CI);

if (actual && actual !== expected) {
  console.error(`Deployment stopped: this repository belongs to the Cloudflare Worker "${expected}", but this build targets ${JSON.stringify(actual)}.`);
  console.error('Disconnect this repository from the duplicate Worker under Settings > Builds. Keep the original contextation-offering connection.');
  process.exit(1);
}

if (workersBuild && !actual) {
  console.error('Deployment stopped: Workers Builds did not identify its target Worker. Check the build configuration before publishing.');
  process.exit(1);
}

console.log(`Deployment target verified: ${actual || expected + ' (local configuration)'}.`);
