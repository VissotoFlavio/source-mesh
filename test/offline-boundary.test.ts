import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    'DNS lookup service',
    "const { lookupService } = await import('node:dns'); lookupService('127.0.0.1', 80, () => {})",
  ],
  [
    'DNS resolve any',
    "const { resolveAny } = await import('node:dns'); resolveAny('localhost')",
  ],
  [
    'DNS typed resolver',
    "const { resolveCaa } = await import('node:dns'); resolveCaa('localhost')",
  ],
  [
    'promise DNS resolver',
    "const { resolveMx } = await import('node:dns/promises'); await resolveMx('localhost')",
  ],
  [
    'socket instance',
    "const net = await import('node:net'); new net.Socket().connect(9, '127.0.0.1')",
  ],
  [
    'resolver instance',
    "const { Resolver } = await import('node:dns'); new Resolver().resolveTxt('localhost')",
  ],
  [
    'UDP socket',
    "const dgram = await import('node:dgram'); dgram.createSocket('udp4')",
  ],
  [
    'UDP bind',
    "const { Socket } = await import('node:dgram'); new Socket('udp4').bind(0)",
  ],
  [
    'TCP listener',
    "const net = await import('node:net'); net.createServer().listen(0)",
  ],
  [
    'subprocess',
    "const { spawn } = await import('node:child_process'); spawn(process.execPath, ['--version'])",
  ],
  [
    'restore subprocess path',
    "const { spawn } = await import('node:child_process'); spawn(process.execPath, ['restore'])",
  ],
  [
    'build subprocess path',
    "const { spawn } = await import('node:child_process'); spawn(process.execPath, ['build'])",
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

test(
  'offline guard permits only the fixed Roslyn invocation',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const helper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../tools/sourcemesh-roslyn/bin/Release/net10.0/sourcemesh-roslyn.dll',
    );
    const host = String.raw`C:\Program Files\dotnet\dotnet.exe`;
    const source = [
      "import { spawn } from 'node:child_process';",
      `const child = spawn(${JSON.stringify(host)}, [${JSON.stringify(helper)}], { cwd: process.cwd(), env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });`,
      'child.stdin.end();',
      "child.once('error', () => process.exit(0));",
      "child.once('close', () => process.exit(0));",
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--import', guardUrl, '--input-type=module', '--eval', source],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /offline boundary blocked a network call/,
    );
  },
);
