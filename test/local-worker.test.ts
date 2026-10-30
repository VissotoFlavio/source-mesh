import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LOCAL_WORKER_PROTOCOL_VERSION,
  LocalWorkerError,
  LocalWorkerRegistry,
  runLocalWorker,
} from '../src/local-worker.js';

const request = {
  version: LOCAL_WORKER_PROTOCOL_VERSION,
  packId: 'fixture',
  payload: {},
} as const;

function registry(script: string): LocalWorkerRegistry {
  return new LocalWorkerRegistry([
    {
      id: 'fixture-worker',
      command: process.execPath,
      args: ['--input-type=module', '--eval', script],
      protocolVersion: LOCAL_WORKER_PROTOCOL_VERSION,
    },
  ]);
}

test('a static local worker returns a versioned graph fragment', async () => {
  const worker = registry(
    "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ version: 1, fragment: { pack: { id: 'fixture', version: '1.0.0' }, nodes: [], edges: [], diagnostics: [] } }) + '\\n'))",
  );
  const result = await runLocalWorker(worker, 'fixture-worker', request);
  assert.equal(result.fragment.pack.id, 'fixture');
});

test('unknown workers and malformed frames fail closed', async () => {
  const worker = registry("process.stdout.write('not-json\\n')");
  await assert.rejects(
    () => runLocalWorker(worker, 'user-provided-command', request),
    (error: unknown) =>
      error instanceof LocalWorkerError && error.code === 'worker_unavailable',
  );
  await assert.rejects(
    () => runLocalWorker(worker, 'fixture-worker', request),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_protocol_invalid',
  );
});
