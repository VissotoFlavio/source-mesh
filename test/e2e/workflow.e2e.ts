import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { openValidatedSnapshot, type Snapshot } from '../../src/index.js';
import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_TOOL_NAMES,
} from '../../src/mcp/contracts.js';

const repository = process.cwd();
const fixture = path.join(repository, 'test', 'fixtures', 'e2e-project');
const csharpFixture = path.join(
  repository,
  'test',
  'fixtures',
  'csharp-project',
);
const cliEntry = path.join(repository, 'dist', 'cli.js');
const denyNetwork = path.join(repository, 'scripts', 'deny-network.mjs');
const sourceMarker = 'E2E_SOURCE_TEXT_MARKER';
const secretMarker = 'E2E_SECRET_VALUE_MARKER';
const malformedMarker = 'E2E_MALFORMED_SOURCE_MARKER';
const temporaryRoots: string[] = [];

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliEnvelope {
  readonly schemaVersion: 1 | 2;
  readonly command: string;
  readonly result?: unknown;
  readonly error?: Record<string, unknown>;
}

interface McpConnection {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stderr: () => string;
}

function runSourceMesh(
  root: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(denyNetwork).href, cliEntry, ...args],
      { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

function parseJson<T>(value: string): T {
  assert.notEqual(value, '');
  return JSON.parse(value) as T;
}

function analyzeArgs(root: string): string[] {
  return [
    'analyze',
    '--root',
    root,
    '--tsconfig',
    'tsconfig.json',
    '--overwrite',
    '--output',
    'json',
  ];
}

function csharpAnalyzeArgs(root: string): string[] {
  return [
    'analyze',
    '--root',
    root,
    '--language',
    'csharp',
    '--solution',
    'Synthetic.sln',
    '--overwrite',
    '--output',
    'json',
  ];
}

function snapshotPath(root: string): string {
  return path.join(root, '.sourcemesh', 'graph.json');
}

async function createFixtureCopy(source = fixture): Promise<string> {
  const root = await mkdtemp(path.join(repository, '.e2e-workflow-'));
  temporaryRoots.push(root);
  await cp(source, root, { recursive: true });
  return root;
}

function findNode(
  snapshot: Snapshot,
  kind: Snapshot['nodes'][number]['kind'],
  name: string,
): Snapshot['nodes'][number] {
  const node = snapshot.nodes.find(
    (candidate) =>
      candidate.kind === kind && 'name' in candidate && candidate.name === name,
  );
  assert.ok(node, `missing ${kind} ${name}`);
  return node;
}

function findQualifiedNode(
  snapshot: Snapshot,
  kind: Snapshot['nodes'][number]['kind'],
  qualifiedName: string,
): Snapshot['nodes'][number] {
  const node = snapshot.nodes.find(
    (candidate) =>
      candidate.kind === kind &&
      'qualifiedName' in candidate &&
      candidate.qualifiedName === qualifiedName,
  );
  assert.ok(node, `missing ${kind} ${qualifiedName}`);
  return node;
}

function findFile(
  snapshot: Snapshot,
  relativePath: string,
): Snapshot['nodes'][number] {
  const node = snapshot.nodes.find(
    (candidate) => candidate.kind === 'file' && candidate.path === relativePath,
  );
  assert.ok(node, `missing file ${relativePath}`);
  return node;
}

function assertNoPrivateValues(value: unknown, root: string): void {
  const serialized =
    typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  for (const privateValue of [
    root,
    repository,
    'E2E_IGNORED_SENTINEL',
    sourceMarker,
    secretMarker,
    malformedMarker,
    'missingLocalTarget',
    'export function malformed',
    'Error:',
    '\n    at ',
  ])
    assert.equal(serialized.includes(privateValue), false, privateValue);
}

function assertBoundedPages(value: unknown, limit: number): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    if (Array.isArray(record.items) && typeof record.total === 'number') {
      assert.ok(record.items.length <= limit);
      assert.equal(typeof record.truncated, 'boolean');
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(value);
}

function cliQuery(
  root: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return runSourceMesh(root, [
    ...args,
    '--root',
    root,
    '--allow-partial',
    '--output',
    'json',
  ]);
}

async function startMcp(root: string): Promise<McpConnection> {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      pathToFileURL(denyNetwork).href,
      cliEntry,
      'mcp',
      '--root',
      root,
    ],
    cwd: repository,
    stderr: 'pipe',
    maxBufferSize: MCP_MAX_MESSAGE_BYTES,
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({
    name: 'SourceMesh local E2E test',
    version: '0.0.0',
  });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

function assertCliSuccess(processResult: ProcessResult): CliEnvelope {
  assert.equal(processResult.code, 0, processResult.stderr);
  assert.equal(processResult.signal, null);
  assert.equal(processResult.stderr, '');
  return parseJson<CliEnvelope>(processResult.stdout);
}

after(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

test('built local workflow is deterministic, bounded, equivalent, and offline', async () => {
  const firstRoot = await createFixtureCopy();
  const secondRoot = await createFixtureCopy();

  const firstAnalysis = assertCliSuccess(
    await runSourceMesh(firstRoot, analyzeArgs(firstRoot)),
  );
  const secondAnalysis = assertCliSuccess(
    await runSourceMesh(secondRoot, analyzeArgs(secondRoot)),
  );
  assert.equal(firstAnalysis.command, 'analyze');
  assert.equal(secondAnalysis.command, 'analyze');
  assert.deepEqual(firstAnalysis.result, secondAnalysis.result);
  assertNoPrivateValues(firstAnalysis, firstRoot);
  assertNoPrivateValues(secondAnalysis, secondRoot);

  const firstBytes = await readFile(snapshotPath(firstRoot));
  const secondBytes = await readFile(snapshotPath(secondRoot));
  assert.deepEqual(firstBytes, secondBytes);

  const repeated = assertCliSuccess(
    await runSourceMesh(firstRoot, analyzeArgs(firstRoot)),
  );
  assert.deepEqual(repeated.result, firstAnalysis.result);
  assert.deepEqual(firstBytes, await readFile(snapshotPath(firstRoot)));

  const snapshot = await openValidatedSnapshot(firstRoot);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.completeness, 'partial');
  assert.equal(
    snapshot.nodes.some(
      (node) => 'path' in node && node.path.includes('generated/'),
    ),
    false,
  );
  assert.equal(
    snapshot.nodes.some((node) => node.name === 'E2E_IGNORED_SENTINEL'),
    false,
  );
  assert.equal(
    snapshot.diagnostics.some((diagnostic) =>
      diagnostic.path?.includes('generated/'),
    ),
    false,
  );
  assertNoPrivateValues(snapshot, firstRoot);
  assertNoPrivateValues(firstBytes.toString('utf8'), firstRoot);

  const service = findNode(snapshot, 'class', 'LocalService');
  const contract = findNode(snapshot, 'interface', 'ServiceContract');
  const base = findNode(snapshot, 'class', 'BaseService');
  const entry = findNode(snapshot, 'function', 'main');
  const invoke = findNode(snapshot, 'function', 'invokeService');
  const create = findNode(snapshot, 'function', 'createService');
  const unresolved = findNode(snapshot, 'function', 'unresolved');
  const entryFile = findFile(snapshot, 'src/entry.js');
  const contractsFile = findFile(snapshot, 'src/contracts.ts');
  const serviceModule = findNode(snapshot, 'module', 'src/service.ts');
  const contractsModule = findNode(snapshot, 'module', 'src/contracts.ts');

  const hasEdge = (kind: string, from: string, to: string): boolean =>
    snapshot.edges.some(
      (edge) => edge.kind === kind && edge.from === from && edge.to === to,
    );
  assert.equal(hasEdge('extends', service.id, base.id), true);
  assert.equal(hasEdge('implements', service.id, contract.id), true);
  assert.equal(hasEdge('imports', serviceModule.id, contractsModule.id), true);
  assert.equal(hasEdge('calls', entry.id, invoke.id), true);
  assert.equal(hasEdge('calls', invoke.id, create.id), true);
  assert.equal(
    snapshot.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'relationship_unresolved' &&
        diagnostic.path === 'src/entry.js' &&
        diagnostic.relationKind === 'calls',
    ),
    true,
  );
  assert.equal(
    snapshot.edges.some(
      (edge) => edge.kind === 'calls' && edge.from === unresolved.id,
    ),
    false,
  );

  const requestTable = [
    {
      command: ['symbol', '--query', 'LocalService', '--limit', '1'],
      tool: 'searchSymbols',
      input: { query: 'LocalService', limit: 1, allowPartial: true },
    },
    {
      command: ['details', '--id', service.id, '--limit', '1'],
      tool: 'getSymbol',
      input: { nodeId: service.id, limit: 1, allowPartial: true },
    },
    {
      command: ['dependencies', '--file-id', entryFile.id, '--limit', '1'],
      tool: 'listFileDependencies',
      input: { fileId: entryFile.id, limit: 1, allowPartial: true },
    },
    {
      command: ['dependents', '--file-id', contractsFile.id, '--limit', '1'],
      tool: 'listFileDependents',
      input: { fileId: contractsFile.id, limit: 1, allowPartial: true },
    },
    {
      command: ['callers', '--name', 'invokeService', '--limit', '1'],
      tool: 'listCallers',
      input: {
        function: { name: 'invokeService' },
        limit: 1,
        allowPartial: true,
      },
    },
    {
      command: ['callees', '--name', 'main', '--limit', '1'],
      tool: 'listCallees',
      input: { function: { name: 'main' }, limit: 1, allowPartial: true },
    },
  ] as const;

  const cliResults: unknown[] = [];
  for (const request of requestTable) {
    const result = await cliQuery(firstRoot, request.command);
    const envelope = assertCliSuccess(result);
    assert.equal(envelope.command, request.command[0]);
    assert.ok(envelope.result);
    assertBoundedPages(envelope.result, 1);
    assertNoPrivateValues(envelope, firstRoot);
    cliResults.push(envelope.result);
  }

  const mcp = await startMcp(firstRoot);
  try {
    const listed = await mcp.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [...MCP_TOOL_NAMES],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
      assert.equal(tool.annotations?.openWorldHint, false);
    }

    for (const [index, request] of requestTable.entries()) {
      const response = await mcp.client.callTool({
        name: request.tool,
        arguments: request.input,
      });
      assert.equal(response.isError ?? false, false);
      assert.deepEqual(response.structuredContent, cliResults[index]);
      assert.equal(response.content.length, 1);
      assert.equal(response.content[0]?.type, 'text');
      assertBoundedPages(response.structuredContent, 1);
      assertNoPrivateValues(response.structuredContent, firstRoot);
      assertNoPrivateValues(
        response.content[0]?.type === 'text'
          ? response.content[0].text
          : response.content[0],
        firstRoot,
      );
    }

    const cliMissing = await runSourceMesh(firstRoot, [
      'details',
      '--root',
      firstRoot,
      '--id',
      `n:${'0'.repeat(64)}`,
      '--allow-partial',
      '--output',
      'json',
    ]);
    assert.equal(cliMissing.code, 3);
    assert.equal(cliMissing.stdout, '');
    const cliError = parseJson<CliEnvelope>(cliMissing.stderr).error;
    assert.deepEqual(cliError, {
      code: 'not_found',
      message: 'The requested graph item was not found.',
      field: 'nodeId',
    });
    const mcpMissing = await mcp.client.callTool({
      name: 'getSymbol',
      arguments: { nodeId: `n:${'0'.repeat(64)}`, allowPartial: true },
    });
    assert.equal(mcpMissing.isError, true);
    assert.deepEqual(mcpMissing.structuredContent, cliError);
    assertNoPrivateValues(cliMissing.stderr, firstRoot);
    assertNoPrivateValues(cliError, firstRoot);
    assertNoPrivateValues(mcpMissing, firstRoot);
  } finally {
    await mcp.client.close();
    assert.equal(mcp.transport.pid, null);
    assert.equal(mcp.stderr(), '');
  }

  const malformedRoot = await createFixtureCopy();
  await writeFile(
    path.join(malformedRoot, 'src', 'malformed.ts'),
    `export function malformed(value: string): string { return value; /* ${malformedMarker}`,
    'utf8',
  );
  const malformed = assertCliSuccess(
    await runSourceMesh(malformedRoot, analyzeArgs(malformedRoot)),
  );
  assert.equal(
    (malformed.result as { completeness: string }).completeness,
    'partial',
  );
  assertNoPrivateValues(malformed, malformedRoot);
  const malformedSnapshot = await openValidatedSnapshot(malformedRoot);
  const malformedBytes = await readFile(snapshotPath(malformedRoot));
  assert.equal(malformedSnapshot.completeness, 'partial');
  assert.deepEqual(
    malformedSnapshot.diagnostics
      .filter((diagnostic) => diagnostic.code === 'relationship_unresolved')
      .map(({ code, severity, message, relationKind, reason, path }) => ({
        code,
        severity,
        message,
        relationKind,
        reason,
        path,
      })),
    [
      {
        code: 'relationship_unresolved',
        severity: 'warning',
        message: 'Relationship could not be resolved.',
        relationKind: 'calls',
        reason: 'unresolved-target',
        path: 'src/entry.js',
      },
    ],
  );
  assertNoPrivateValues(malformedSnapshot, malformedRoot);
  assertNoPrivateValues(malformedBytes.toString('utf8'), malformedRoot);
  const partialQuery = await runSourceMesh(malformedRoot, [
    'symbol',
    '--root',
    malformedRoot,
    '--query',
    'LocalService',
    '--output',
    'json',
  ]);
  assert.equal(partialQuery.code, 3);
  assert.equal(partialQuery.stdout, '');
  assert.equal(
    parseJson<CliEnvelope>(partialQuery.stderr).error?.code,
    'partial_not_allowed',
  );
  assertNoPrivateValues(partialQuery.stderr, malformedRoot);
  const allowedPartial = assertCliSuccess(
    await cliQuery(malformedRoot, ['symbol', '--query', 'LocalService']),
  );
  assertNoPrivateValues(allowedPartial, malformedRoot);
});

test(
  'built C# workflow proves v2 extraction, equivalence, and fail-closed persistence',
  { skip: process.platform !== 'win32' },
  async () => {
    const firstRoot = await createFixtureCopy(csharpFixture);
    const secondRoot = await createFixtureCopy(csharpFixture);

    const firstAnalysis = assertCliSuccess(
      await runSourceMesh(firstRoot, csharpAnalyzeArgs(firstRoot)),
    );
    const secondAnalysis = assertCliSuccess(
      await runSourceMesh(secondRoot, csharpAnalyzeArgs(secondRoot)),
    );
    assert.equal(firstAnalysis.command, 'analyze');
    assert.equal(firstAnalysis.schemaVersion, 2);
    assert.equal(secondAnalysis.schemaVersion, 2);
    assert.deepEqual(firstAnalysis.result, secondAnalysis.result);
    assertNoPrivateValues(firstAnalysis, firstRoot);
    assertNoPrivateValues(secondAnalysis, secondRoot);

    const firstBytes = await readFile(snapshotPath(firstRoot));
    const secondBytes = await readFile(snapshotPath(secondRoot));
    assert.deepEqual(firstBytes, secondBytes);

    const repeated = assertCliSuccess(
      await runSourceMesh(firstRoot, csharpAnalyzeArgs(firstRoot)),
    );
    assert.deepEqual(repeated.result, firstAnalysis.result);
    assert.deepEqual(firstBytes, await readFile(snapshotPath(firstRoot)));

    const snapshot = await openValidatedSnapshot(firstRoot);
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.completeness, 'complete');
    assertNoPrivateValues(snapshot, firstRoot);
    assertNoPrivateValues(firstBytes.toString('utf8'), firstRoot);

    const appProject = findNode(snapshot, 'project', 'App');
    const libraryProject = findNode(snapshot, 'project', 'Library');
    const appFile = findFile(snapshot, 'src/App/Entry.cs');
    const libraryFile = findFile(snapshot, 'src/Library/Contracts.cs');
    const appModule = findNode(snapshot, 'module', 'src/App/Entry.cs');
    const appNamespace = findQualifiedNode(
      snapshot,
      'namespace',
      'Synthetic.App',
    );
    const libraryNamespace = findQualifiedNode(
      snapshot,
      'namespace',
      'Synthetic.Library',
    );
    const application = findNode(snapshot, 'class', 'Application');
    const baseProcessor = findNode(snapshot, 'class', 'BaseProcessor');
    const processor = findNode(snapshot, 'interface', 'IProcessor');
    const process = findQualifiedNode(
      snapshot,
      'function',
      'Synthetic.App.Application.Process',
    );
    const run = findQualifiedNode(
      snapshot,
      'function',
      'Synthetic.App.Application.Run',
    );
    const format = findQualifiedNode(
      snapshot,
      'function',
      'Synthetic.Library.BaseProcessor.Format',
    );
    const name = findNode(snapshot, 'variable', 'Name');
    const processValue = findQualifiedNode(
      snapshot,
      'parameter',
      'Synthetic.App.Application.Process.value',
    );
    const runInput = findNode(snapshot, 'parameter', 'input');
    assert.ok(findNode(snapshot, 'class', 'SharedType'));
    assert.ok(appFile.id);
    assert.ok(libraryFile.id);
    assert.ok(appNamespace.id);
    assert.ok(name.id);
    assert.ok(processValue.id);
    assert.ok(runInput.id);

    const hasEdge = (kind: string, from: string, to: string): boolean =>
      snapshot.edges.some(
        (edge) => edge.kind === kind && edge.from === from && edge.to === to,
      );
    assert.equal(hasEdge('references', appProject.id, libraryProject.id), true);
    assert.equal(hasEdge('uses', appModule.id, libraryNamespace.id), true);
    assert.equal(hasEdge('extends', application.id, baseProcessor.id), true);
    assert.equal(hasEdge('implements', application.id, processor.id), true);
    assert.equal(hasEdge('calls', run.id, process.id), true);
    assert.equal(hasEdge('calls', process.id, format.id), true);

    const requestTable = [
      {
        command: ['symbol', '--query', 'Application', '--limit', '10'],
        tool: 'searchSymbols',
        input: { query: 'Application', limit: 10, allowPartial: true },
      },
      {
        command: ['details', '--id', application.id, '--limit', '10'],
        tool: 'getSymbol',
        input: { nodeId: application.id, limit: 10, allowPartial: true },
      },
      {
        command: ['dependencies', '--file-id', appFile.id, '--limit', '10'],
        tool: 'listFileDependencies',
        input: { fileId: appFile.id, limit: 10, allowPartial: true },
      },
      {
        command: ['dependents', '--file-id', libraryFile.id, '--limit', '10'],
        tool: 'listFileDependents',
        input: { fileId: libraryFile.id, limit: 10, allowPartial: true },
      },
      {
        command: [
          'callers',
          '--name',
          'Process',
          '--qualified-name',
          'Synthetic.App.Application.Process',
          '--limit',
          '10',
        ],
        tool: 'listCallers',
        input: {
          function: {
            name: 'Process',
            qualifiedName: 'Synthetic.App.Application.Process',
          },
          limit: 10,
          allowPartial: true,
        },
      },
      {
        command: ['callees', '--name', 'Run', '--limit', '10'],
        tool: 'listCallees',
        input: {
          function: { name: 'Run' },
          limit: 10,
          allowPartial: true,
        },
      },
    ] as const;

    const cliResults: unknown[] = [];
    for (const request of requestTable) {
      const result = await cliQuery(firstRoot, request.command);
      const envelope = assertCliSuccess(result);
      assert.equal(envelope.schemaVersion, 2);
      assert.equal(envelope.command, request.command[0]);
      assert.ok(envelope.result);
      assertBoundedPages(envelope.result, 10);
      assertNoPrivateValues(envelope, firstRoot);
      cliResults.push(envelope.result);
    }

    const mcp = await startMcp(firstRoot);
    try {
      const listed = await mcp.client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        [...MCP_TOOL_NAMES],
      );
      for (const tool of listed.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
        assert.equal(tool.annotations?.idempotentHint, true);
        assert.equal(tool.annotations?.openWorldHint, false);
      }

      for (const [index, request] of requestTable.entries()) {
        const response = await mcp.client.callTool({
          name: request.tool,
          arguments: request.input,
        });
        assert.equal(response.isError ?? false, false);
        assert.deepEqual(response.structuredContent, cliResults[index]);
        assert.equal(response.content.length, 1);
        assert.equal(response.content[0]?.type, 'text');
        assertBoundedPages(response.structuredContent, 10);
        assertNoPrivateValues(response.structuredContent, firstRoot);
        assertNoPrivateValues(
          response.content[0]?.type === 'text'
            ? response.content[0].text
            : response.content[0],
          firstRoot,
        );
      }
    } finally {
      await mcp.client.close();
      assert.equal(mcp.transport.pid, null);
      assert.equal(mcp.stderr(), '');
    }

    const noPersist = await runSourceMesh(firstRoot, [
      'analyze',
      '--root',
      firstRoot,
      '--language',
      'csharp',
      '--solution',
      'Synthetic.sln',
      '--output',
      'json',
    ]);
    assert.equal(noPersist.code, 4);
    assert.equal(noPersist.stdout, '');
    assert.equal(
      parseJson<CliEnvelope>(noPersist.stderr).error?.code,
      'snapshot_conflict',
    );
    assert.deepEqual(firstBytes, await readFile(snapshotPath(firstRoot)));
    assertNoPrivateValues(noPersist.stderr, firstRoot);
  },
);
