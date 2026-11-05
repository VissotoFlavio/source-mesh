import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { GraphFragment } from './packs.js';

/** Shared by the parent executor and source-owned local worker bridges. */
export const LOCAL_WORKER_PROTOCOL_VERSION = 2;
export const LOCAL_WORKER_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const LOCAL_WORKER_MAX_STDERR_BYTES = 64 * 1024;
// Large local-pack results use a parent-owned staging area; normal
// stdin/stdout frames remain capped at 2 MiB.
export const LOCAL_WORKER_MAX_RESPONSE_CHUNK_BYTES =
  LOCAL_WORKER_MAX_MESSAGE_BYTES;
// This matches the snapshot file ceiling while leaving stdout frames bounded.
export const LOCAL_WORKER_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const LOCAL_WORKER_MAX_RESPONSE_CHUNKS =
  LOCAL_WORKER_MAX_RESPONSE_BYTES / LOCAL_WORKER_MAX_RESPONSE_CHUNK_BYTES;
export const LOCAL_WORKER_MAX_RESPONSE_MANIFEST_BYTES = 1024 * 1024;
export const LOCAL_WORKER_RESPONSE_VERSION = 1;
export const LOCAL_WORKER_RESPONSE_MANIFEST = 'manifest.json';

export type LocalWorkerErrorCode =
  | 'worker_unavailable'
  | 'worker_timeout'
  | 'worker_failed'
  | 'worker_protocol_invalid'
  | 'worker_resource_limit';

export class LocalWorkerError extends Error {
  constructor(readonly code: LocalWorkerErrorCode) {
    super('The local language-pack worker could not complete.');
    this.name = 'LocalWorkerError';
  }
}

export interface LocalWorkerDefinition {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly protocolVersion: typeof LOCAL_WORKER_PROTOCOL_VERSION;
}

export interface LocalWorkerRequest {
  readonly version: typeof LOCAL_WORKER_PROTOCOL_VERSION;
  readonly packId: string;
  readonly payload: unknown;
}

export interface LocalWorkerResponse {
  readonly version: typeof LOCAL_WORKER_PROTOCOL_VERSION;
  readonly fragment: GraphFragment;
  /** Pack-private, versioned data validated by the owning pack. */
  readonly payload?: unknown;
}

export interface LocalWorkerRunOptions {
  readonly timeoutMs?: number;
}

function fail(code: LocalWorkerErrorCode): never {
  throw new LocalWorkerError(code);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function closedObject(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  return (
    object(value) && Object.keys(value).every((key) => allowed.includes(key))
  );
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validFragment(value: unknown): value is GraphFragment {
  if (
    !object(value) ||
    !object(value.pack) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.diagnostics)
  )
    return false;
  return (
    typeof value.pack.id === 'string' && typeof value.pack.version === 'string'
  );
}

export class LocalWorkerRegistry {
  readonly #workers = new Map<string, LocalWorkerDefinition>();

  constructor(workers: readonly LocalWorkerDefinition[]) {
    for (const worker of workers) {
      if (
        !worker.id ||
        !worker.command ||
        worker.protocolVersion !== LOCAL_WORKER_PROTOCOL_VERSION ||
        this.#workers.has(worker.id)
      )
        throw new Error('Invalid local worker registry.');
      this.#workers.set(
        worker.id,
        Object.freeze({ ...worker, args: Object.freeze([...worker.args]) }),
      );
    }
  }

  get(id: string): LocalWorkerDefinition | undefined {
    return this.#workers.get(id);
  }
}

async function execute(
  worker: LocalWorkerDefinition,
  input: string,
  timeoutMs: number | undefined,
): Promise<{
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  timedOut: boolean;
  overflow: boolean;
}> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(worker.command, worker.args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: null,
        timedOut: false,
        overflow: false,
      });
      return;
    }
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let out = 0,
      err = 0,
      timedOut = false,
      overflow = false;
    const stop = () => {
      timedOut = true;
      child.kill();
    };
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs);
    const append = (
      items: Buffer[],
      chunk: Buffer,
      total: number,
      cap: number,
    ) => {
      if (chunk.byteLength > cap - total) {
        overflow = true;
        stop();
        return total;
      }
      items.push(Buffer.from(chunk));
      return total + chunk.byteLength;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      out = append(stdout, chunk, out, LOCAL_WORKER_MAX_MESSAGE_BYTES);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = append(stderr, chunk, err, LOCAL_WORKER_MAX_STDERR_BYTES);
    });
    const done = (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code,
        timedOut,
        overflow,
      });
    };
    child.on('error', () => done(null));
    child.on('close', done);
    child.stdin.end(input);
  });
}

function frame(value: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    fail('worker_protocol_invalid');
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n'))
    fail('worker_protocol_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('worker_protocol_invalid');
  }
  if (!object(parsed)) fail('worker_protocol_invalid');
  return parsed;
}

function response(value: unknown): LocalWorkerResponse {
  if (
    !closedObject(value, ['version', 'fragment', 'payload']) ||
    value.version !== LOCAL_WORKER_PROTOCOL_VERSION ||
    !validFragment(value.fragment)
  )
    fail('worker_protocol_invalid');
  return Object.freeze({
    version: LOCAL_WORKER_PROTOCOL_VERSION,
    fragment: value.fragment,
    ...(Object.hasOwn(value, 'payload') ? { payload: value.payload } : {}),
  });
}

async function readChunkedResponse(
  footer: Record<string, unknown>,
  directory: string,
): Promise<LocalWorkerResponse> {
  if (
    !closedObject(footer, ['version', 'response']) ||
    footer.version !== LOCAL_WORKER_PROTOCOL_VERSION ||
    !closedObject(footer.response, ['version', 'manifest', 'bytes']) ||
    footer.response.version !== LOCAL_WORKER_RESPONSE_VERSION ||
    footer.response.manifest !== LOCAL_WORKER_RESPONSE_MANIFEST ||
    !positiveInteger(footer.response.bytes) ||
    footer.response.bytes > LOCAL_WORKER_MAX_RESPONSE_MANIFEST_BYTES
  )
    fail('worker_protocol_invalid');
  const directoryStat = await fs.lstat(directory).catch(() => undefined);
  if (
    directoryStat === undefined ||
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink()
  )
    fail('worker_protocol_invalid');
  const manifestPath = path.join(directory, LOCAL_WORKER_RESPONSE_MANIFEST);
  const manifestStat = await fs.lstat(manifestPath).catch(() => undefined);
  if (
    manifestStat === undefined ||
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size !== footer.response.bytes
  )
    fail('worker_protocol_invalid');
  let manifest: Record<string, unknown>;
  try {
    manifest = frame(
      Buffer.concat([
        await fs.readFile(manifestPath),
        Buffer.from('\n', 'utf8'),
      ]),
    );
  } catch {
    fail('worker_protocol_invalid');
  }
  if (
    !closedObject(manifest, ['version', 'chunks', 'bytes']) ||
    manifest.version !== LOCAL_WORKER_RESPONSE_VERSION ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length === 0
  )
    fail('worker_protocol_invalid');
  if (
    manifest.chunks.length > LOCAL_WORKER_MAX_RESPONSE_CHUNKS ||
    !positiveInteger(manifest.bytes) ||
    manifest.bytes > LOCAL_WORKER_MAX_RESPONSE_BYTES
  )
    fail('worker_resource_limit');
  const chunks: Buffer[] = [];
  let total = 0;
  const expectedFiles = new Set([LOCAL_WORKER_RESPONSE_MANIFEST]);
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const descriptor = manifest.chunks[index];
    const name = `chunk-${String(index).padStart(6, '0')}.bin`;
    if (
      !closedObject(descriptor, ['index', 'name', 'bytes']) ||
      descriptor.index !== index ||
      descriptor.name !== name
    )
      fail('worker_protocol_invalid');
    if (
      !positiveInteger(descriptor.bytes) ||
      descriptor.bytes > LOCAL_WORKER_MAX_RESPONSE_CHUNK_BYTES ||
      total > LOCAL_WORKER_MAX_RESPONSE_BYTES - descriptor.bytes
    )
      fail('worker_resource_limit');
    expectedFiles.add(name);
    const chunkPath = path.join(directory, name);
    const chunkStat = await fs.lstat(chunkPath).catch(() => undefined);
    if (
      chunkStat === undefined ||
      !chunkStat.isFile() ||
      chunkStat.isSymbolicLink() ||
      chunkStat.size !== descriptor.bytes
    )
      fail('worker_protocol_invalid');
    const chunk = await fs.readFile(chunkPath).catch(() => undefined);
    if (chunk === undefined || chunk.byteLength !== descriptor.bytes)
      fail('worker_protocol_invalid');
    chunks.push(chunk);
    total += descriptor.bytes;
  }
  if (total !== manifest.bytes) fail('worker_protocol_invalid');
  const entries = await fs.readdir(directory).catch(() => undefined);
  if (
    entries === undefined ||
    entries.length !== expectedFiles.size ||
    entries.some((entry) => !expectedFiles.has(entry))
  )
    fail('worker_protocol_invalid');
  return response(frame(Buffer.concat(chunks, total)));
}

/** Executes only a source-owned worker selected by registry id. */
export async function runLocalWorker(
  registry: LocalWorkerRegistry,
  workerId: string,
  request: LocalWorkerRequest,
  options: LocalWorkerRunOptions = {},
): Promise<LocalWorkerResponse> {
  const worker = registry.get(workerId);
  if (!worker) fail('worker_unavailable');
  if (request.version !== LOCAL_WORKER_PROTOCOL_VERSION)
    fail('worker_protocol_invalid');
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  )
    fail('worker_resource_limit');
  if (
    Buffer.byteLength(`${JSON.stringify(request)}\n`, 'utf8') >
    LOCAL_WORKER_MAX_MESSAGE_BYTES
  )
    fail('worker_resource_limit');
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), 'sourcemesh-local-worker-'),
  );
  const input = `${JSON.stringify({
    ...request,
    response: { version: LOCAL_WORKER_RESPONSE_VERSION, directory },
  })}\n`;
  let completed = false;
  try {
    if (Buffer.byteLength(input, 'utf8') > LOCAL_WORKER_MAX_MESSAGE_BYTES)
      fail('worker_resource_limit');
    const result = await execute(worker, input, options.timeoutMs);
    if (result.overflow) fail('worker_resource_limit');
    if (result.timedOut) fail('worker_timeout');
    if (result.code !== 0 || result.stderr.byteLength !== 0)
      fail('worker_failed');
    const value = await readChunkedResponse(frame(result.stdout), directory);
    completed = true;
    return value;
  } finally {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      if (completed) fail('worker_failed');
    }
  }
}
