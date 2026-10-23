import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createGraphQueryService,
  fileId,
  openValidatedSnapshot,
  type GraphQueryService,
  type QueryResponseV1,
} from '../src/index.js';
import { main } from '../src/cli.js';
import { MCP_MAX_MESSAGE_BYTES, MCP_TOOL_NAMES } from '../src/mcp/contracts.js';

const roots: string[] = [];
const serverEntry = path.join(process.cwd(), 'dist', 'cli.js');
const sourceEntry = path.join(process.cwd(), 'src', 'cli.ts');

function localServerArgs(): string[] {
  return existsSync(serverEntry)
    ? [serverEntry]
    : ['--import', 'tsx', sourceEntry];
}

interface TestIO {
  readonly stdout: string;
  readonly stderr: string;
}

function capture(): {
  readonly io: {
    stdout: (value: string) => void;
    stderr: (value: string) => void;
  };
  readonly read: () => TestIO;
} {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

async function createSyntheticRepository(): Promise<{
  readonly root: string;
  readonly service: GraphQueryService;
  readonly callerId: string;
  readonly targetId: string;
}> {
  const root = await mkdtemp(path.join(process.cwd(), '.mcp-stdio-'));
  roots.push(root);
  await writeFile(
    path.join(root, 'package.json'),
    '{"type":"module"}\n',
    'utf8',
  );
  await writeFile(
    path.join(root, 'a.ts'),
    "import { target } from './b.js';\nexport function caller() { return target(); }\n",
    'utf8',
  );
  await writeFile(
    path.join(root, 'b.ts'),
    'export function target() { return 1; }\n',
    'utf8',
  );
  const io = capture();
  assert.equal(
    await main(
      ['analyze', '--root', root, '--overwrite', '--output', 'json'],
      undefined,
      io.io,
    ),
    0,
  );
  assert.equal(io.read().stderr, '');
  const snapshot = await openValidatedSnapshot(root);
  const caller = snapshot.nodes.find(
    (node) => node.kind === 'function' && node.name === 'caller',
  );
  const target = snapshot.nodes.find(
    (node) => node.kind === 'function' && node.name === 'target',
  );
  assert.ok(caller && target);
  return {
    root,
    service: createGraphQueryService(snapshot),
    callerId: caller.id,
    targetId: target.id,
  };
}

async function startClient(
  root: string,
  offline = false,
): Promise<{
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly readStderr: () => string;
}> {
  let stderr = '';
  const args = [
    ...(offline
      ? [
          '--import',
          pathToFileURL(path.join(process.cwd(), 'scripts', 'deny-network.mjs'))
            .href,
        ]
      : []),
    ...localServerArgs(),
    'mcp',
    '--root',
    root,
  ];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: process.cwd(),
    stderr: 'pipe',
    maxBufferSize: MCP_MAX_MESSAGE_BYTES,
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({
    name: 'SourceMesh integration test',
    version: '0.0.0',
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`,
      { cause: error },
    );
  }
  return { client, transport, readStderr: () => stderr };
}

async function assertToolCall(
  client: Client,
  name: string,
  input: Record<string, unknown>,
  expected: QueryResponseV1 | { readonly code: string },
): Promise<void> {
  const result = await client.callTool({ name, arguments: input });
  if (result.isError) throw new Error(JSON.stringify(result));
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(result.structuredContent, expected);
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  assert.equal(
    content?.type === 'text' ? content.text : '',
    JSON.stringify(expected),
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test('real local client sees exactly six closed read-only tools and deterministic DTOs', async () => {
  const repository = await createSyntheticRepository();
  const connection = await startClient(repository.root);
  try {
    const listed = await connection.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [...MCP_TOOL_NAMES],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
      assert.equal(tool.annotations?.openWorldHint, false);
    }
    const capabilities = connection.client.getServerCapabilities();
    assert.ok(capabilities?.tools);
    assert.equal('resources' in (capabilities ?? {}), false);
    assert.equal('prompts' in (capabilities ?? {}), false);
    assert.deepEqual(connection.client.getServerVersion(), {
      name: 'SourceMesh',
      version: '0.0.0',
    });

    await assertToolCall(
      connection.client,
      'searchSymbols',
      { query: 'caller', allowPartial: true },
      repository.service.searchSymbols({
        operation: 'searchSymbols',
        query: 'caller',
        allowPartial: true,
      }) as QueryResponseV1,
    );
    await assertToolCall(
      connection.client,
      'getSymbol',
      { nodeId: repository.callerId, allowPartial: true },
      repository.service.getSymbol({
        operation: 'getSymbol',
        nodeId: repository.callerId,
        allowPartial: true,
      }) as QueryResponseV1,
    );
    await assertToolCall(
      connection.client,
      'listFileDependencies',
      { fileId: fileId('a.ts'), allowPartial: true },
      repository.service.listFileDependencies({
        operation: 'listFileDependencies',
        fileId: fileId('a.ts'),
        allowPartial: true,
      }) as QueryResponseV1,
    );
    await assertToolCall(
      connection.client,
      'listFileDependents',
      { fileId: fileId('b.ts'), allowPartial: true },
      repository.service.listFileDependents({
        operation: 'listFileDependents',
        fileId: fileId('b.ts'),
        allowPartial: true,
      }) as QueryResponseV1,
    );
    await assertToolCall(
      connection.client,
      'listCallers',
      { function: { name: 'target' }, allowPartial: true },
      repository.service.listCallers({
        operation: 'listCallers',
        function: { name: 'target' },
        allowPartial: true,
      }) as QueryResponseV1,
    );
    await assertToolCall(
      connection.client,
      'listCallees',
      { function: { name: 'caller' }, allowPartial: true },
      repository.service.listCallees({
        operation: 'listCallees',
        function: { name: 'caller' },
        allowPartial: true,
      }) as QueryResponseV1,
    );

    const first = await connection.client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'caller', limit: 1, allowPartial: true },
    });
    const second = await connection.client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'caller', limit: 1, allowPartial: true },
    });
    assert.deepEqual(second.structuredContent, first.structuredContent);
    assert.equal(
      (second.content[0] as { readonly text: string }).text,
      (first.content[0] as { readonly text: string }).text,
    );

    const unknownField = await connection.client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'caller', unsafe: true },
    });
    assert.equal(unknownField.isError, true);
    const oversizedLimit = await connection.client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'caller', limit: 101 },
    });
    assert.equal(oversizedLimit.isError, true);
  } finally {
    await connection.client.close();
    assert.equal(connection.transport.pid, null);
    assert.equal(connection.readStderr(), '');
  }
});

test('the server remains offline when the child is guarded', async () => {
  const repository = await createSyntheticRepository();
  const connection = await startClient(repository.root, true);
  try {
    const listed = await connection.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [...MCP_TOOL_NAMES],
    );
    const result = await connection.client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'target', allowPartial: true },
    });
    assert.equal(result.isError ?? false, false);
  } finally {
    await connection.client.close();
    assert.equal(connection.transport.pid, null);
    assert.equal(connection.readStderr(), '');
  }
});

test('startup failures stay on sanitized stderr and never write protocol stdout', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.mcp-missing-'));
  roots.push(root);
  const child = spawn(
    process.execPath,
    [...localServerArgs(), 'mcp', '--root', root],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });
  assert.notEqual(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, 'The snapshot could not be found.\n');
  assert.equal(stderr.includes(root), false);
});
