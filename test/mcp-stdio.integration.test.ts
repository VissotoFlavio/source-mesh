import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
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
import { createMcpServer } from '../src/mcp/server.js';

const roots: string[] = [];
const serverEntry = path.join(process.cwd(), 'dist', 'cli.js');
const sourceEntry = path.join(process.cwd(), 'src', 'cli.ts');
const processSpawnAvailable = spawn.name !== 'denyNetworkAccess';
const processTest = processSpawnAvailable ? test : test.skip;
const sourceMarker = 'E2E_SOURCE_TEXT_MARKER';
const secretMarker = 'E2E_SECRET_VALUE_MARKER';
const untrustedPayload = 'E2E_UNTRUSTED_RPC_PAYLOAD';

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
    `import { target } from './b.js';\nexport function caller() { return target(); }\nexport function shared() { return '${sourceMarker}'; }\n`,
    'utf8',
  );
  await writeFile(
    path.join(root, 'b.ts'),
    'export function target() { return 1; }\nexport function shared() { return 2; }\n',
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

function spawnRawServer(
  root: string,
  extraArgs: readonly string[] = [],
): {
  readonly child: ReturnType<typeof spawn>;
  readonly read: () => TestIO;
} {
  const child = spawn(
    process.execPath,
    [...localServerArgs(), 'mcp', '--root', root, ...extraArgs],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return { child, read: () => ({ stdout, stderr }) };
}

function assertSafeProcessOutput(
  output: TestIO,
  sensitiveValues: readonly string[],
): void {
  const serialized = `${output.stdout}\n${output.stderr}`;
  for (const value of sensitiveValues)
    assert.equal(serialized.includes(value), false, value);
  assert.equal(/\b(?:Error|TypeError|SyntaxError):/u.test(serialized), false);
  assert.equal(/\n\s+at /u.test(serialized), false);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function assertErrorCall(
  client: Client,
  name: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  const result = await client.callTool({ name, arguments: input });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, expected);
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  assert.equal(
    content?.type === 'text' ? content.text : '',
    JSON.stringify(expected),
  );
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

processTest(
  'real local client sees exactly six closed read-only tools and deterministic DTOs',
  async () => {
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

      await assertErrorCall(
        connection.client,
        'searchSymbols',
        { query: 'caller', unsafe: true },
        { code: 'invalid_request', message: 'The query request is invalid.' },
      );
      await assertErrorCall(
        connection.client,
        'searchSymbols',
        { query: 'caller', limit: 101 },
        {
          code: 'invalid_request',
          message: 'The query request is invalid.',
          field: 'limit',
        },
      );
      await assertErrorCall(
        connection.client,
        'searchSymbols',
        { limit: 1 },
        {
          code: 'invalid_request',
          message: 'The query request is invalid.',
          field: 'query',
        },
      );
      await assertErrorCall(
        connection.client,
        'searchSymbols',
        { query: 'caller', containerId: 'not-a-node-id' },
        {
          code: 'invalid_request',
          message: 'The query request is invalid.',
          field: 'containerId',
        },
      );
      await assertErrorCall(
        connection.client,
        'searchSymbols',
        { query: 'caller', path: 'src\\file.ts' },
        {
          code: 'invalid_request',
          message: 'The query request is invalid.',
          field: 'path',
        },
      );
      await assertErrorCall(
        connection.client,
        'searchSymbols',
        { query: 'caller', cursor: 'not-a-cursor', allowPartial: true },
        {
          code: 'invalid_request',
          message: 'The query request is invalid.',
          field: 'cursor',
        },
      );
      await assertErrorCall(
        connection.client,
        'getSymbol',
        { nodeId: `n:${'0'.repeat(64)}`, allowPartial: true },
        {
          code: 'not_found',
          message: 'The requested graph item was not found.',
          field: 'nodeId',
        },
      );
      const ambiguous = repository.service.getSymbol({
        operation: 'getSymbol',
        selector: { name: 'shared' },
        allowPartial: true,
      });
      assert.ok('code' in ambiguous);
      await assertErrorCall(
        connection.client,
        'getSymbol',
        { selector: { name: 'shared' }, allowPartial: true },
        ambiguous as unknown as Record<string, unknown>,
      );
    } finally {
      await connection.client.close();
      assert.equal(connection.transport.pid, null);
      assert.equal(connection.readStderr(), '');
    }
  },
);

processTest(
  'the server remains offline when the child is guarded',
  async () => {
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
  },
);

test('schema failures stay in the public DTO and never invoke the query service', async () => {
  let invocations = 0;
  const diagnostics: string[] = [];
  const throwingService: GraphQueryService = {
    searchSymbols: () => {
      invocations += 1;
      throw new Error('C:\\private\\source.ts: secret source and stack');
    },
    getSymbol: () => {
      invocations += 1;
      throw new Error('C:\\private\\source.ts: secret source and stack');
    },
    listFileDependencies: () => {
      invocations += 1;
      throw new Error('C:\\private\\source.ts: secret source and stack');
    },
    listFileDependents: () => {
      invocations += 1;
      throw new Error('C:\\private\\source.ts: secret source and stack');
    },
    listCallers: () => {
      invocations += 1;
      throw new Error('C:\\private\\source.ts: secret source and stack');
    },
    listCallees: () => {
      invocations += 1;
      throw new Error('C:\\private\\source.ts: secret source and stack');
    },
  };
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer(throwingService, (code) => {
    diagnostics.push(code);
  });
  const client = new Client({
    name: 'SourceMesh in-memory integration test',
    version: '0.0.0',
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await assertErrorCall(
      client,
      'searchSymbols',
      { query: 'target', unsafe: true },
      { code: 'invalid_request', message: 'The query request is invalid.' },
    );
    assert.equal(invocations, 0);

    const internal = await client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'target' },
    });
    assert.equal(internal.isError, true);
    assert.deepEqual(internal.structuredContent, {
      code: 'internal',
      message: 'The operation could not be completed.',
    });
    assert.equal(JSON.stringify(internal).includes('private'), false);
    assert.equal(JSON.stringify(internal).includes('secret source'), false);
    assert.deepEqual(diagnostics, ['mcp_internal_error']);
  } finally {
    await client.close();
    await server.close();
  }
});

processTest(
  'the pinned query service ignores a snapshot replacement after startup',
  async () => {
    const repository = await createSyntheticRepository();
    const connection = await startClient(repository.root);
    try {
      await writeFile(
        path.join(repository.root, 'replacement.ts'),
        'export function replacement() { return 3; }\n',
        'utf8',
      );
      const io = capture();
      assert.equal(
        await main(
          [
            'analyze',
            '--root',
            repository.root,
            '--overwrite',
            '--output',
            'json',
          ],
          undefined,
          io.io,
        ),
        0,
      );
      assert.equal(io.read().stderr, '');

      await assertToolCall(
        connection.client,
        'searchSymbols',
        { query: 'replacement', allowPartial: true },
        repository.service.searchSymbols({
          operation: 'searchSymbols',
          query: 'replacement',
          allowPartial: true,
        }) as QueryResponseV1,
      );
    } finally {
      await connection.client.close();
      assert.equal(connection.transport.pid, null);
      assert.equal(connection.readStderr(), '');
    }
  },
);

processTest(
  'raw malformed and oversized frames fail closed without protocol stdout',
  async () => {
    const repository = await createSyntheticRepository();
    const snapshotBytes = await readFile(
      path.join(repository.root, '.sourcemesh', 'graph.json'),
    );

    const malformed = spawnRawServer(repository.root);
    malformed.child.stdin?.end(
      `not-json ${untrustedPayload}\n${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        params: {
          source: sourceMarker,
          secret: secretMarker,
          snapshot: snapshotBytes.toString('utf8'),
          payload: untrustedPayload,
        },
      })}\n`,
    );
    const malformedExit = await waitForExit(malformed.child);
    assert.equal(malformedExit.code, 0);
    const malformedOutput = malformed.read();
    assert.equal(malformedOutput.stdout, '');
    assert.match(malformedOutput.stderr, /^(?:mcp_transport_error\n)+$/u);
    assertSafeProcessOutput(malformedOutput, [
      repository.root,
      sourceMarker,
      secretMarker,
      untrustedPayload,
      snapshotBytes.toString('utf8'),
    ]);

    const oversized = spawnRawServer(repository.root);
    oversized.child.stdin?.end(
      Buffer.concat([
        Buffer.from(
          `${JSON.stringify({
            source: sourceMarker,
            secret: secretMarker,
            payload: untrustedPayload,
          })}\n`,
        ),
        snapshotBytes,
        Buffer.alloc(MCP_MAX_MESSAGE_BYTES + 1, 0x41),
        Buffer.from('\n'),
      ]),
    );
    const oversizedExit = await waitForExit(oversized.child);
    assert.equal(oversizedExit.code, 0);
    const oversizedOutput = oversized.read();
    assert.equal(oversizedOutput.stdout, '');
    assert.match(oversizedOutput.stderr, /^(?:mcp_transport_error\n)+$/u);
    assertSafeProcessOutput(oversizedOutput, [
      repository.root,
      sourceMarker,
      secretMarker,
      untrustedPayload,
      snapshotBytes.toString('utf8'),
    ]);
  },
);

processTest(
  'unsafe, malformed, and unsupported snapshots fail before protocol startup',
  async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.mcp-startup-'));
    roots.push(root);
    await mkdir(path.join(root, '.sourcemesh'), { recursive: true });

    const unsafe = spawnRawServer(root, [
      '--snapshot',
      '.sourcemesh/../graph.json',
    ]);
    unsafe.child.stdin?.end();
    const unsafeExit = await waitForExit(unsafe.child);
    assert.equal(unsafeExit.code, 2);
    assert.deepEqual(unsafe.read(), {
      stdout: '',
      stderr: 'The command arguments are invalid. (snapshot)\n',
    });

    await writeFile(
      path.join(root, '.sourcemesh', 'graph.json'),
      JSON.stringify({
        source: sourceMarker,
        secret: secretMarker,
        payload: untrustedPayload,
        snapshot: 'malformed snapshot bytes',
      }),
      'utf8',
    );
    const malformed = spawnRawServer(root);
    malformed.child.stdin?.end();
    const malformedExit = await waitForExit(malformed.child);
    assert.equal(malformedExit.code, 1);
    assert.deepEqual(malformed.read(), {
      stdout: '',
      stderr: 'The snapshot is invalid.\n',
    });
    assertSafeProcessOutput(malformed.read(), [
      root,
      sourceMarker,
      secretMarker,
      untrustedPayload,
      'malformed snapshot bytes',
    ]);

    await writeFile(
      path.join(root, '.sourcemesh', 'graph.json'),
      '{"schemaVersion":2}\n',
      'utf8',
    );
    const unsupported = spawnRawServer(root);
    unsupported.child.stdin?.end();
    const unsupportedExit = await waitForExit(unsupported.child);
    assert.equal(unsupportedExit.code, 1);
    assert.deepEqual(unsupported.read(), {
      stdout: '',
      stderr: 'The snapshot schema is unsupported.\n',
    });
  },
);

processTest(
  'EOF and signals close the local server cleanly and repeatedly',
  async () => {
    const repository = await createSyntheticRepository();

    const eof = spawnRawServer(repository.root);
    eof.child.stdin?.end();
    const eofExit = await waitForExit(eof.child);
    assert.equal(eofExit.code, 0);
    assert.deepEqual(eof.read(), { stdout: '', stderr: '' });

    const signaled = spawnRawServer(repository.root);
    signaled.child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'signal-test', version: '0.0.0' },
        },
      })}\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const onData = (): void => resolve();
      const onError = (error: Error): void => reject(error);
      signaled.child.stdout?.once('data', onData);
      signaled.child.stdout?.once('error', onError);
    });
    assert.equal(signaled.child.kill('SIGTERM'), true);
    const signaledExit = await waitForExit(signaled.child);
    if (process.platform === 'win32') {
      assert.equal(signaledExit.code, null);
      assert.equal(signaledExit.signal, 'SIGTERM');
    } else {
      assert.equal(signaledExit.code, 0);
      assert.equal(signaledExit.signal, null);
    }
    assert.equal(signaled.read().stderr, '');
    for (const line of signaled.read().stdout.trim().split('\n'))
      assert.doesNotThrow(() => JSON.parse(line));
  },
);

processTest(
  'startup failures stay on sanitized stderr and never write protocol stdout',
  async () => {
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
  },
);
