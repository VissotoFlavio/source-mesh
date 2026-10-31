import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_WORKER_PROTOCOL_VERSION,
  LocalWorkerRegistry,
  runLocalWorker,
} from '../local-worker.js';
import type {
  AnalysisRequest,
  GraphFragment,
  LanguagePack,
  LanguagePackManifest,
} from '../packs.js';
import type { CSharpAnalysisManifest } from './csharp/contracts.js';
import { discoverCSharpManifest } from './csharp/discovery.js';
import { extractCSharpDeclarationGraph } from './csharp/extractor.js';
import type {
  CSharpWorkerOptions,
  CSharpWorkerResult,
} from './csharp/worker.js';

const manifest: LanguagePackManifest = {
  contractVersion: 1,
  id: 'csharp',
  version: '1.0.0',
  extensions: ['.cs'],
  executionMode: 'local-worker',
  workerProtocolVersion: LOCAL_WORKER_PROTOCOL_VERSION,
  capabilities: ['project-manifest', 'source-analysis', 'semantic-relations'],
};

const bridge = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts')
      ? './csharp/bridge.ts'
      : './csharp/bridge.js',
    import.meta.url,
  ),
);
const bridgeArgs = bridge.endsWith('.ts')
  ? ['--import', 'tsx', bridge]
  : [bridge];

/** The C# worker is a source-owned bridge; callers cannot select commands. */
const csharpWorkers = new LocalWorkerRegistry([
  {
    id: 'csharp-roslyn',
    command: process.execPath,
    args: bridgeArgs,
    protocolVersion: LOCAL_WORKER_PROTOCOL_VERSION,
  },
]);

type BridgePayload =
  | {
      readonly kind: 'analysis-request';
      readonly request: {
        readonly repositoryName: string;
        readonly files: readonly {
          readonly path: string;
          readonly base64: string;
        }[];
      };
    }
  | {
      readonly kind: 'manifest';
      readonly repositoryRoot: string;
      readonly manifest: CSharpAnalysisManifest;
      readonly options?: CSharpWorkerOptions;
    };

export interface CSharpLanguagePack extends LanguagePack {
  analyze(request: AnalysisRequest): Promise<GraphFragment>;
  analyzeManifest(
    repositoryRoot: string,
    analysisManifest: CSharpAnalysisManifest,
    options?: CSharpWorkerOptions,
  ): Promise<CSharpWorkerResult>;
  readonly discover: typeof discoverCSharpManifest;
  readonly extract: typeof extractCSharpDeclarationGraph;
}

function encodedRequest(request: AnalysisRequest): BridgePayload {
  return {
    kind: 'analysis-request',
    request: {
      repositoryName: request.repository.name,
      files: request.files.map((file) => ({
        path: file.path,
        base64: Buffer.from(file.contents).toString('base64'),
      })),
    },
  };
}

async function invoke(payload: BridgePayload, timeoutMs?: number) {
  return await runLocalWorker(
    csharpWorkers,
    'csharp-roslyn',
    {
      version: LOCAL_WORKER_PROTOCOL_VERSION,
      packId: manifest.id,
      payload,
    },
    ...(timeoutMs === undefined ? [] : [{ timeoutMs }]),
  );
}

function csharpWorkerResult(value: unknown): value is CSharpWorkerResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { projects?: unknown }).projects) &&
    Array.isArray((value as { diagnostics?: unknown }).diagnostics)
  );
}

async function analyze(request: AnalysisRequest): Promise<GraphFragment> {
  return (await invoke(encodedRequest(request))).fragment;
}

async function analyzeManifest(
  repositoryRoot: string,
  analysisManifest: CSharpAnalysisManifest,
  options: CSharpWorkerOptions = {},
): Promise<CSharpWorkerResult> {
  const response = await invoke(
    {
      kind: 'manifest',
      repositoryRoot: path.resolve(repositoryRoot),
      manifest: analysisManifest,
      ...(Object.keys(options).length === 0 ? {} : { options }),
    },
    options.timeoutMs,
  );
  if (!csharpWorkerResult(response.payload))
    throw new Error('The local C# worker returned an invalid payload.');
  return response.payload;
}

/** The source-owned C# pack boundary used by the CLI. */
export const csharpPack: CSharpLanguagePack = Object.freeze({
  manifest: Object.freeze({
    ...manifest,
    extensions: Object.freeze([...manifest.extensions]),
    capabilities: Object.freeze([...manifest.capabilities]),
  }),
  discover: discoverCSharpManifest,
  analyze,
  analyzeManifest,
  extract: extractCSharpDeclarationGraph,
});

export { discoverCSharpManifest, extractCSharpDeclarationGraph };
