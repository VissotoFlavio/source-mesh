import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import {
  LOCAL_WORKER_MAX_RESPONSE_CHUNK_BYTES,
  LOCAL_WORKER_MAX_RESPONSE_BYTES,
  LOCAL_WORKER_PROTOCOL_VERSION,
  LOCAL_WORKER_RESPONSE_MANIFEST,
  LOCAL_WORKER_RESPONSE_VERSION,
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

function chunkedWorker(
  mode: 'valid' | 'traversal' | 'symlink' | 'bytes' | 'aggregate' = 'valid',
  payloadBytes = 0,
): string {
  return `
    import fs from 'node:fs';
    import path from 'node:path';
    process.stdin.once('data', (input) => {
      const request = JSON.parse(String(input));
      const directory = request.response.directory;
      const frame = Buffer.from(JSON.stringify({
        version: ${LOCAL_WORKER_PROTOCOL_VERSION},
        fragment: { pack: { id: 'fixture', version: '1.0.0' }, nodes: [], edges: [], diagnostics: [] },
        payload: { text: 'x'.repeat(${payloadBytes}), responseDirectory: directory },
      }) + '\\n', 'utf8');
      const chunks = [];
      for (let offset = 0, index = 0; offset < frame.length; index += 1) {
        const name = 'chunk-' + String(index).padStart(6, '0') + '.bin';
        const chunk = frame.subarray(offset, offset + ${LOCAL_WORKER_MAX_RESPONSE_CHUNK_BYTES});
        fs.writeFileSync(path.join(directory, name), chunk, { flag: 'wx' });
        chunks.push({ index, name, bytes: chunk.length });
        offset += chunk.length;
      }
      if ('${mode}' === 'traversal') chunks[0].name = '../outside.bin';
      if ('${mode}' === 'bytes') chunks[0].bytes += 1;
      if ('${mode}' === 'symlink') {
        const target = path.join(directory, 'target.bin');
        fs.renameSync(path.join(directory, chunks[0].name), target);
        fs.symlinkSync(target, path.join(directory, chunks[0].name), 'file');
      }
      const bytes = '${mode}' === 'aggregate' ? ${LOCAL_WORKER_MAX_RESPONSE_BYTES + 1} : frame.length;
      const manifest = Buffer.from(JSON.stringify({ version: ${LOCAL_WORKER_RESPONSE_VERSION}, chunks, bytes }), 'utf8');
      fs.writeFileSync(path.join(directory, '${LOCAL_WORKER_RESPONSE_MANIFEST}'), manifest, { flag: 'wx' });
      process.stdout.write(JSON.stringify({
        version: ${LOCAL_WORKER_PROTOCOL_VERSION},
        response: { version: ${LOCAL_WORKER_RESPONSE_VERSION}, manifest: '${LOCAL_WORKER_RESPONSE_MANIFEST}', bytes: manifest.length },
      }) + '\\n');
    });
  `;
}

test('a static local worker returns a versioned graph fragment', async () => {
  const worker = registry(chunkedWorker());
  const result = await runLocalWorker(worker, 'fixture-worker', request);
  assert.equal(result.fragment.pack.id, 'fixture');
  assert.equal(
    existsSync(
      (result.payload as { responseDirectory: string }).responseDirectory,
    ),
    false,
  );
});

test('a local worker reconstructs a bounded multi-chunk response', async () => {
  const result = await runLocalWorker(
    registry(chunkedWorker('valid', 3 * 1024 * 1024)),
    'fixture-worker',
    request,
  );
  assert.equal(
    (result.payload as { text: string }).text.length,
    3 * 1024 * 1024,
  );
});

test('unknown workers and malformed frames fail closed', async () => {
  const worker = registry("process.stdout.write('not-json\\n')");
  await assert.rejects(
    () => runLocalWorker(worker, 'user-provided-command', request),
    (error: unknown) =>
      error instanceof LocalWorkerError && error.code === 'worker_unavailable',
  );
  await assert.rejects(
    () =>
      runLocalWorker(registry(chunkedWorker()), 'fixture-worker', {
        ...request,
        version: 1 as typeof LOCAL_WORKER_PROTOCOL_VERSION,
      }),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_protocol_invalid',
  );
  await assert.rejects(
    () => runLocalWorker(worker, 'fixture-worker', request),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_protocol_invalid',
  );
  await assert.rejects(
    () =>
      runLocalWorker(
        registry(chunkedWorker('traversal')),
        'fixture-worker',
        request,
      ),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_protocol_invalid',
  );
  await assert.rejects(
    () =>
      runLocalWorker(
        registry(chunkedWorker('bytes')),
        'fixture-worker',
        request,
      ),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_protocol_invalid',
  );
  await assert.rejects(
    () =>
      runLocalWorker(
        registry(chunkedWorker('aggregate')),
        'fixture-worker',
        request,
      ),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_resource_limit',
  );
  await assert.rejects(
    () =>
      runLocalWorker(
        registry(chunkedWorker('symlink')),
        'fixture-worker',
        request,
      ),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      (error.code === 'worker_protocol_invalid' ||
        error.code === 'worker_failed'),
  );
});

test('crashes, timeouts, stderr, and oversized frames fail closed', async () => {
  const crash = registry('process.exit(1)');
  await assert.rejects(
    () => runLocalWorker(crash, 'fixture-worker', request),
    (error: unknown) =>
      error instanceof LocalWorkerError && error.code === 'worker_failed',
  );
  const timeout = registry('setTimeout(() => {}, 10_000)');
  await assert.rejects(
    () => runLocalWorker(timeout, 'fixture-worker', request, { timeoutMs: 10 }),
    (error: unknown) =>
      error instanceof LocalWorkerError && error.code === 'worker_timeout',
  );
  const stderr = registry("process.stderr.write('unexpected')");
  await assert.rejects(
    () => runLocalWorker(stderr, 'fixture-worker', request),
    (error: unknown) =>
      error instanceof LocalWorkerError && error.code === 'worker_failed',
  );
  await assert.rejects(
    () =>
      runLocalWorker(registry(''), 'fixture-worker', {
        ...request,
        payload: 'x'.repeat(2 * 1024 * 1024),
      }),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_resource_limit',
  );
  const oversized = registry(
    "process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1))",
  );
  await assert.rejects(
    () => runLocalWorker(oversized, 'fixture-worker', request),
    (error: unknown) =>
      error instanceof LocalWorkerError &&
      error.code === 'worker_resource_limit',
  );
});
