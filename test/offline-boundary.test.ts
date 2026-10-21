import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const guardUrl = new URL('../scripts/deny-network.mjs', import.meta.url).href;

test('offline guard rejects a synthetic network attempt', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      guardUrl,
      '--input-type=module',
      '--eval',
      "await fetch('https://example.invalid')",
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline boundary blocked a network call/);
});
