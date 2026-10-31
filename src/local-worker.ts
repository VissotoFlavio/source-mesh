import { spawn } from 'node:child_process';

import type { GraphFragment } from './packs.js';

export const LOCAL_WORKER_PROTOCOL_VERSION = 1;
export const LOCAL_WORKER_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const LOCAL_WORKER_MAX_STDERR_BYTES = 64 * 1024;

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
      });
      return;
    }
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let out = 0,
      err = 0,
      timedOut = false;
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
      });
    };
    child.on('error', () => done(null));
    child.on('close', done);
    child.stdin.end(input);
  });
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
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
  )
    fail('worker_resource_limit');
  const input = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(input) > LOCAL_WORKER_MAX_MESSAGE_BYTES)
    fail('worker_resource_limit');
  const result = await execute(worker, input, options.timeoutMs);
  if (result.timedOut) fail('worker_timeout');
  if (result.code !== 0 || result.stderr.byteLength !== 0)
    fail('worker_failed');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } catch {
    fail('worker_protocol_invalid');
  }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n'))
    fail('worker_protocol_invalid');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('worker_protocol_invalid');
  }
  if (
    !object(value) ||
    value.version !== LOCAL_WORKER_PROTOCOL_VERSION ||
    !validFragment(value.fragment)
  )
    fail('worker_protocol_invalid');
  return Object.freeze({
    version: LOCAL_WORKER_PROTOCOL_VERSION,
    fragment: value.fragment,
  });
}
