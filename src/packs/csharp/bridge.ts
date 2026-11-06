import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  LOCAL_WORKER_MAX_MESSAGE_BYTES,
  LOCAL_WORKER_MAX_RESPONSE_BYTES,
  LOCAL_WORKER_MAX_RESPONSE_CHUNK_BYTES,
  LOCAL_WORKER_MAX_RESPONSE_MANIFEST_BYTES,
  LOCAL_WORKER_PROTOCOL_VERSION,
  LOCAL_WORKER_RESPONSE_MANIFEST,
  LOCAL_WORKER_RESPONSE_VERSION,
} from '../../local-worker.js';
import type { GraphFragment } from '../../packs.js';
import type { SnapshotV3 } from '../../snapshot/types.js';
import type { CSharpAnalysisManifest } from './contracts.js';
import { extractCSharpDeclarationGraph } from './extractor.js';
import {
  analyzeCSharpManifest,
  type CSharpWorkerOptions,
  type CSharpWorkerResult,
} from './worker.js';

interface AnalysisPayload {
  readonly kind: 'analysis-request';
  readonly request: {
    readonly repositoryName: string;
    readonly files: readonly {
      readonly path: string;
      readonly base64: string;
    }[];
  };
}
interface ManifestPayload {
  readonly kind: 'manifest';
  readonly repositoryRoot: string;
  readonly manifest: CSharpAnalysisManifest;
  readonly options?: CSharpWorkerOptions;
}
type Payload = AnalysisPayload | ManifestPayload;
interface ResponseTarget {
  readonly version: typeof LOCAL_WORKER_RESPONSE_VERSION;
  readonly directory: string;
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
function safePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/u.test(value) &&
    !value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  );
}
function validPayload(value: unknown): value is Payload {
  if (
    !object(value) ||
    (value.kind !== 'analysis-request' && value.kind !== 'manifest')
  )
    return false;
  if (value.kind === 'manifest')
    return typeof value.repositoryRoot === 'string' && object(value.manifest);
  return (
    object(value.request) &&
    typeof value.request.repositoryName === 'string' &&
    Array.isArray(value.request.files) &&
    value.request.files.every(
      (file) =>
        object(file) && safePath(file.path) && typeof file.base64 === 'string',
    )
  );
}
function validResponseTarget(value: unknown): value is ResponseTarget {
  return (
    closedObject(value, ['version', 'directory']) &&
    value.version === LOCAL_WORKER_RESPONSE_VERSION &&
    typeof value.directory === 'string' &&
    path.isAbsolute(value.directory)
  );
}

async function input(): Promise<{
  readonly payload: Payload;
  readonly response: ResponseTarget;
}> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > LOCAL_WORKER_MAX_MESSAGE_BYTES)
      throw new Error('invalid input');
    chunks.push(buffer);
  }
  const frame = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks),
  );
  if (!frame.endsWith('\n') || frame.slice(0, -1).includes('\n'))
    throw new Error('invalid input');
  const request: unknown = JSON.parse(frame);
  if (
    !object(request) ||
    request.version !== LOCAL_WORKER_PROTOCOL_VERSION ||
    request.packId !== 'csharp' ||
    !validPayload(request.payload) ||
    !validResponseTarget(request.response)
  )
    throw new Error('invalid input');
  return {
    payload: request.payload as Payload,
    response: request.response as ResponseTarget,
  };
}

function fragment(
  snapshot: SnapshotV3,
  paths: ReadonlySet<string>,
): GraphFragment {
  const nodes = snapshot.nodes
    .filter(
      (
        node,
      ): node is Exclude<
        (typeof snapshot.nodes)[number],
        { readonly kind: 'repository' }
      > => node.kind !== 'repository' && paths.has(node.path),
    )
    .map((node) => ({
      key: node.id,
      kind: node.kind,
      path: node.path,
      name: node.name,
    }));
  const keys = new Set(nodes.map((node) => node.key));
  return {
    pack: { id: 'csharp', version: '1.0.0' },
    nodes,
    edges: snapshot.edges
      .filter((edge) => keys.has(edge.from) && keys.has(edge.to))
      .map((edge) => ({
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
        confidence: 'syntactic' as const,
      })),
    diagnostics: snapshot.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.path === undefined || paths.has(diagnostic.path),
      )
      .map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      })),
  };
}

function implicitManifest(paths: readonly string[]): CSharpAnalysisManifest {
  return {
    language: 'csharp',
    selection: {
      version: 1,
      kind: 'explicit-projects',
      projects: ['SourceMesh.csproj'],
    },
    projects: [{ path: 'SourceMesh.csproj', references: [], files: paths }],
  };
}

async function fromRequest(payload: AnalysisPayload): Promise<{
  readonly worker: CSharpWorkerResult;
  readonly result: GraphFragment;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'sourcemesh-csharp-pack-'));
  try {
    const files = payload.request.files;
    for (const file of files) {
      const target = path.join(root, ...file.path.split('/'));
      if (path.relative(root, target).startsWith('..'))
        throw new Error('invalid path');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.base64, 'base64'), {
        flag: 'wx',
      });
    }
    const manifest = implicitManifest(files.map((file) => file.path));
    const worker = await analyzeCSharpManifest(root, manifest);
    const snapshot = extractCSharpDeclarationGraph({
      repositoryRoot: root,
      repositoryName: payload.request.repositoryName,
      manifest,
      worker,
    });
    return {
      worker,
      result: fragment(snapshot, new Set(manifest.projects[0]!.files)),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function run(payload: Payload): Promise<{
  readonly worker: CSharpWorkerResult;
  readonly result: GraphFragment;
}> {
  if (payload.kind === 'analysis-request') return await fromRequest(payload);
  const worker = await analyzeCSharpManifest(
    payload.repositoryRoot,
    payload.manifest,
    payload.options,
  );
  const paths = new Set(
    payload.manifest.projects.flatMap((project) => project.files),
  );
  const snapshot = extractCSharpDeclarationGraph({
    repositoryRoot: payload.repositoryRoot,
    manifest: payload.manifest,
    worker,
  });
  return { worker, result: fragment(snapshot, paths) };
}

async function writeResponse(
  value: {
    readonly worker: CSharpWorkerResult;
    readonly result: GraphFragment;
  },
  target: ResponseTarget,
): Promise<string> {
  const directory = await fs.lstat(target.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('invalid response directory');
  const response = Buffer.from(
    `${JSON.stringify({
      version: LOCAL_WORKER_PROTOCOL_VERSION,
      fragment: value.result,
      payload: value.worker,
    })}\n`,
    'utf8',
  );
  if (
    response.byteLength === 0 ||
    response.byteLength > LOCAL_WORKER_MAX_RESPONSE_BYTES
  )
    throw new Error('response limit');
  const chunks: { index: number; name: string; bytes: number }[] = [];
  for (let offset = 0, index = 0; offset < response.byteLength; index += 1) {
    const name = `chunk-${String(index).padStart(6, '0')}.bin`;
    const chunk = response.subarray(
      offset,
      offset + LOCAL_WORKER_MAX_RESPONSE_CHUNK_BYTES,
    );
    await fs.writeFile(path.join(target.directory, name), chunk, {
      flag: 'wx',
    });
    chunks.push({ index, name, bytes: chunk.byteLength });
    offset += chunk.byteLength;
  }
  const manifest = Buffer.from(
    JSON.stringify({
      version: LOCAL_WORKER_RESPONSE_VERSION,
      chunks,
      bytes: response.byteLength,
    }),
    'utf8',
  );
  if (
    manifest.byteLength === 0 ||
    manifest.byteLength > LOCAL_WORKER_MAX_RESPONSE_MANIFEST_BYTES
  )
    throw new Error('manifest limit');
  await fs.writeFile(
    path.join(target.directory, LOCAL_WORKER_RESPONSE_MANIFEST),
    manifest,
    {
      flag: 'wx',
    },
  );
  return `${JSON.stringify({
    version: LOCAL_WORKER_PROTOCOL_VERSION,
    response: {
      version: LOCAL_WORKER_RESPONSE_VERSION,
      manifest: LOCAL_WORKER_RESPONSE_MANIFEST,
      bytes: manifest.byteLength,
    },
  })}\n`;
}

try {
  const request = await input();
  const result = await run(request.payload);
  process.stdout.write(await writeResponse(result, request.response));
} catch {
  process.exitCode = 1;
}
