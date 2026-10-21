import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const guardUrl = new URL('../scripts/deny-network.mjs', import.meta.url).href;

const prohibitedAttempts = [
  ['global fetch', "await fetch('https://example.invalid')"],
  [
    'named HTTP request',
    "const { request } = await import('node:http'); request('http://127.0.0.1')",
  ],
  [
    'named DNS lookup',
    "const { lookup } = await import('node:dns'); lookup('localhost')",
  ],
  [
    'socket instance',
    "const net = await import('node:net'); new net.Socket().connect(9, '127.0.0.1')",
  ],
  [
    'resolver instance',
    "const { Resolver } = await import('node:dns'); new Resolver().resolve4('localhost')",
  ],
  [
    'UDP socket',
    "const dgram = await import('node:dgram'); dgram.createSocket('udp4')",
  ],
  [
    'subprocess',
    "const { spawn } = await import('node:child_process'); spawn(process.execPath, ['--version'])",
  ],
] as const;

test('offline guard rejects representative network and escape paths', async (t) => {
  for (const [name, source] of prohibitedAttempts) {
    await t.test(name, () => {
      const result = spawnSync(
        process.execPath,
        ['--import', guardUrl, '--input-type=module', '--eval', source],
        { encoding: 'utf8' },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /offline boundary blocked a network call/);
    });
  }
});
