import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const classifier = path.join(
  repositoryRoot,
  'scripts',
  'is-missing-release-response.mjs',
);

function classify(response: string): number | null {
  return spawnSync(process.execPath, [classifier], {
    encoding: 'utf8',
    input: response,
  }).status;
}

test('release candidate workflow recognizes only known missing-release responses', () => {
  assert.equal(classify('release not found\n'), 0);
  assert.equal(classify('gh: Not Found (HTTP 404)\n'), 0);
  assert.equal(classify('HTTP 401: Bad credentials\n'), 1);
  assert.equal(classify('request timed out\n'), 1);
});
