import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const app = fileURLToPath(new URL('../', import.meta.url));
const roots = [app, resolve(app, '..'), resolve(app, '../..')];
const cases = [
  { name: 'local', env: { WORKERS_CI: '', WRANGLER_CI_OVERRIDE_NAME: '' }, status: 0 },
  { name: 'original Worker', env: { WORKERS_CI: '1', WRANGLER_CI_OVERRIDE_NAME: 'contextation-offering' }, status: 0 },
  { name: 'duplicate Worker', env: { WORKERS_CI: '1', WRANGLER_CI_OVERRIDE_NAME: 'course-offering-dsp-602' }, status: 1 },
  { name: 'unidentified CI target', env: { WORKERS_CI: '1', WRANGLER_CI_OVERRIDE_NAME: '' }, status: 1 },
];

for (const root of roots) {
  const path = resolve(root, 'wrangler.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.name, 'contextation-offering');
  assert.equal(config.keep_vars, true);
  assert.deepEqual(config.secrets.required, ['SITE_PASSWORD']);
  assert.equal(config.assets.run_worker_first, true);
  assert.deepEqual(config.routes, [{ pattern: 'offering.contextation.com', custom_domain: true }]);
  const match = /^node (\S+)$/.exec(config.build.command);
  assert.ok(match, 'The build guard must use a single Node script.');
  const cwd = resolve(dirname(path), config.build.cwd);
  for (const test of cases) {
    const result = spawnSync(process.execPath, [match[1]], {
      cwd, env: { ...process.env, ...test.env }, encoding: 'utf8',
    });
    assert.equal(result.status, test.status, `${root}: ${test.name}\n${result.stderr}`);
    if (test.status) assert.match(result.stderr, /Deployment stopped:/);
  }
}
console.log('PASS all three deployment roots preserve runtime settings, require the password binding, and reject the duplicate or unidentified Worker.');
