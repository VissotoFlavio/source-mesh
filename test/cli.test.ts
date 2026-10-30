import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileId, openValidatedSnapshot, repositoryIdV2 } from '../src/index.js';
import type { CliIO, CliServices } from '../src/cli.js';
import { main } from '../src/cli.js';
import type {
  DeclarationGraph,
  CallRelationResponseV1,
  FileRelationResponseV1,
  GetSymbolResponseV1,
  GraphQueryService,
  GraphQueryServiceV2,
  QueryResponseV1,
  SearchResponseV1,
  Snapshot,
  SnapshotV2,
} from '../src/index.js';

function capture(): CliIO & {
  readonly stdoutValue: string;
  readonly stderrValue: string;
} {
  let stdoutValue = '';
  let stderrValue = '';
  return {
    stdout: (value) => {
      stdoutValue += value;
    },
    stderr: (value) => {
      stderrValue += value;
    },
    get stdoutValue() {
      return stdoutValue;
    },
    get stderrValue() {
      return stderrValue;
    },
  };
}

function emptyGraph(): DeclarationGraph {
  return {
    schemaVersion: 1,
    repository: { root: '.', name: 'repository' },
    nodes: [],
    edges: [],
    diagnostics: [],
  };
}

function queryResponse(): QueryResponseV1 {
  return {
    operation: 'searchSymbols',
    page: {
      schemaVersion: 1,
      completeness: 'complete',
      items: [],
      total: 0,
      truncated: false,
    },
  };
}

function injectedServices(overrides: Partial<CliServices> = {}): CliServices {
  return {
    discoverCSharpManifest: async () => ({ diagnostics: [] }),
    discoverSourceFiles: async () => ({
      repositoryRoot: '/selected/root',
      sources: [],
      diagnostics: [],
    }),
    writeSnapshot: async () => ({
      path: '/selected/root/.sourcemesh/graph.json',
      digest: 'a'.repeat(64),
      bytes: 12,
    }),
    openValidatedSnapshot: async () => ({
      ...emptyGraph(),
      completeness: 'complete',
    }),
    createGraphQueryService: () =>
      ({
        searchSymbols: () => queryResponse(),
        getSymbol: () => queryResponse(),
        listFileDependencies: () => queryResponse(),
        listFileDependents: () => queryResponse(),
        listCallers: () => queryResponse(),
        listCallees: () => queryResponse(),
      }) as unknown as GraphQueryService,
    ...overrides,
  };
}

test('help and grammar failures are deterministic and do not invoke services', async () => {
  const helpIO = capture();
  assert.equal(await main(['--help'], injectedServices(), helpIO), 0);
  assert.match(helpIO.stdoutValue, /Commands: analyze/u);
  assert.equal(helpIO.stderrValue, '');

  let invoked = false;
  const services = injectedServices({
    openValidatedSnapshot: async () => {
      invoked = true;
      throw new Error('must not run');
    },
  });
  const errorIO = capture();
  assert.equal(
    await main(
      ['symbol', '--root', '/repo', '--query', 'value', '--query', 'other'],
      services,
      errorIO,
    ),
    2,
  );
  assert.equal(invoked, false);
  assert.equal(errorIO.stdoutValue, '');
  assert.match(errorIO.stderrValue, /arguments are invalid/u);
});

test('unknown option diagnostics never echo untrusted option values', async () => {
  const secret = 'TOP-SECRET-OPTION-VALUE';
  for (const output of ['human', 'json'] as const) {
    const io = capture();
    assert.equal(
      await main(
        [
          'symbol',
          '--root',
          '/repo',
          '--query',
          'value',
          `--token=${secret}`,
          '--output',
          output,
        ],
        injectedServices(),
        io,
      ),
      2,
    );
    assert.equal(io.stdoutValue, '');
    assert.equal(io.stderrValue.includes(secret), false);
    if (output === 'json') {
      assert.deepEqual(JSON.parse(io.stderrValue).error, {
        code: 'invalid_arguments',
        message: 'The command arguments are invalid.',
        field: 'option',
      });
    } else {
      assert.equal(
        io.stderrValue,
        'The command arguments are invalid. (option)\n',
      );
    }
  }
});

test('read commands require an explicit restricted snapshot selection', async () => {
  for (const args of [
    ['symbol', '--root', '/repo', '--query', 'value'],
    [
      'symbol',
      '--root',
      '/repo',
      '--snapshot',
      '.sourcemesh/other.json',
      '--query',
      'value',
    ],
    [
      'symbol',
      '--root',
      '/repo',
      '--snapshot',
      '.sourcemesh/snapshots/not/valid.json',
      '--query',
      'value',
    ],
  ]) {
    const io = capture();
    assert.equal(await main(args, injectedServices(), io), 2);
    assert.equal(io.stdoutValue, '');
    assert.match(io.stderrValue, /arguments are invalid/u);
  }

  const legacy = capture();
  assert.equal(
    await main(
      [
        'symbol',
        '--root',
        '/repo',
        '--snapshot',
        '.sourcemesh/graph.json',
        '--query',
        'value',
      ],
      injectedServices(),
      legacy,
    ),
    0,
  );
});

test(
  'linked POSIX bin invocation executes the CLI entrypoint',
  { skip: process.platform === 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.sourcemesh-bin-'));
    const binDirectory = path.join(root, 'node_modules', '.bin');
    const binPath = path.join(binDirectory, 'sourcemesh');
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.symlinkSync(path.join(process.cwd(), 'src', 'cli.ts'), binPath, 'file');
    try {
      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', binPath, '--help'],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.match(output, /SourceMesh local analysis CLI/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('analyze derives a versioned create-only path and rejects overwrite', async () => {
  const writes: string[] = [];
  const services = injectedServices({
    writeSnapshot: async (_root, _snapshot, options) => {
      writes.push(options.path);
      return {
        path: '/selected/root/.sourcemesh/result.json',
        digest: 'b'.repeat(64),
        bytes: 42,
      };
    },
  });
  const firstIO = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        '/repo',
        '--snapshot-id',
        'result-1',
        '--output',
        'json',
      ],
      services,
      firstIO,
    ),
    0,
  );
  assert.deepEqual(writes, ['.sourcemesh/snapshots/result-1.json']);
  assert.equal(firstIO.stderrValue, '');
  assert.deepEqual(JSON.parse(firstIO.stdoutValue), {
    schemaVersion: 1,
    command: 'analyze',
    result: {
      snapshotPath: '.sourcemesh/snapshots/result-1.json',
      completeness: 'complete',
      digest: 'b'.repeat(64),
      bytes: 42,
      handover:
        'Start a new MCP process with --snapshot .sourcemesh/snapshots/result-1.json; existing MCP processes remain pinned to their original snapshot.',
    },
  });

  const overwriteIO = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        '/repo',
        '--snapshot-id',
        'result-1',
        '--overwrite',
        '--output',
        'json',
      ],
      services,
      overwriteIO,
    ),
    2,
  );
  assert.deepEqual(writes, ['.sourcemesh/snapshots/result-1.json']);
});

test('analyze rejects unsafe snapshot IDs before invoking services', async () => {
  for (const snapshotId of [
    '../escape',
    'with/slash',
    'UPPER',
    'é',
    'con',
    'a'.repeat(65),
  ]) {
    const io = capture();
    assert.equal(
      await main(
        ['analyze', '--root', '/repo', '--snapshot-id', snapshotId],
        injectedServices(),
        io,
      ),
      2,
    );
    assert.equal(io.stdoutValue, '');
    assert.equal(io.stderrValue.includes(snapshotId), false);
  }
});

test('csharp analyze uses the injected manifest discovery service', async () => {
  let calls = 0;
  const manifest = {
    language: 'csharp' as const,
    selection: { kind: 'project' as const, path: 'App.csproj' },
    projects: [
      {
        path: 'App.csproj',
        references: [],
        files: ['App.cs'],
      },
    ],
  };
  const successIO = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        '/repo',
        '--snapshot-id',
        'csharp-manifest',
        '--language',
        'csharp',
        '--project',
        'App.csproj',
        '--output',
        'json',
      ],
      injectedServices({
        discoverCSharpManifest: async (root, selection) => {
          calls += 1;
          assert.equal(root, '/repo');
          assert.deepEqual(selection, { project: 'App.csproj' });
          return { manifest, diagnostics: [] };
        },
      }),
      successIO,
    ),
    0,
  );
  assert.equal(calls, 1);
  assert.equal(
    JSON.parse(successIO.stdoutValue).result.kind,
    'csharp-manifest',
  );

  const failureIO = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        '/repo',
        '--snapshot-id',
        'csharp-manifest-failure',
        '--language',
        'csharp',
        '--project',
        'App.csproj',
        '--output',
        'json',
      ],
      injectedServices({
        discoverCSharpManifest: async () => ({
          diagnostics: [
            {
              code: 'path_invalid' as const,
              severity: 'error' as const,
              message: 'The selected C# path is invalid.',
            },
          ],
        }),
      }),
      failureIO,
    ),
    1,
  );
  assert.equal(failureIO.stdoutValue, '');
  assert.equal(JSON.parse(failureIO.stderrValue).error.code, 'analysis_failed');
});

test('csharp analyze writes a v2 versioned create-only snapshot', async () => {
  const manifest = {
    language: 'csharp' as const,
    selection: { kind: 'project' as const, path: 'App.csproj' },
    projects: [{ path: 'App.csproj', references: [], files: ['App.cs'] }],
  };
  const snapshot: SnapshotV2 = {
    schemaVersion: 2,
    completeness: 'complete',
    repository: { root: '.', name: 'repository' },
    nodes: [
      {
        id: repositoryIdV2(),
        kind: 'repository',
        root: '.',
        name: 'repository',
      },
    ],
    edges: [],
    diagnostics: [],
  };
  for (const snapshotId of ['csharp-v2']) {
    let writes = 0;
    const io = capture();
    assert.equal(
      await main(
        [
          'analyze',
          '--root',
          '/repo',
          '--snapshot-id',
          snapshotId,
          '--language',
          'csharp',
          '--project',
          'App.csproj',
          '--output',
          'json',
        ],
        injectedServices({
          discoverCSharpManifest: async () => ({ manifest, diagnostics: [] }),
          analyzeCSharpManifest: async () => ({
            projects: [],
            diagnostics: [],
          }),
          extractCSharpDeclarationGraph: () => snapshot,
          writeSnapshot: async (_root, value, options) => {
            writes += 1;
            assert.equal(value.schemaVersion, 2);
            assert.equal(options.path, '.sourcemesh/snapshots/csharp-v2.json');
            return {
              path: '/repo/.sourcemesh/result.json',
              digest: 'b'.repeat(64),
              bytes: 10,
            };
          },
        }),
        io,
      ),
      0,
    );
    assert.equal(writes, 1);
    assert.equal(io.stderrValue, '');
    assert.equal(JSON.parse(io.stdoutValue).schemaVersion, 2);
  }
});

test('csharp analyze forwards public compiler options and reports compiler diagnostics', async () => {
  const manifest = {
    language: 'csharp' as const,
    selection: { kind: 'project' as const, path: 'App.csproj' },
    projects: [{ path: 'App.csproj', references: [], files: ['App.cs'] }],
  };
  const snapshot: SnapshotV2 = {
    schemaVersion: 2,
    completeness: 'complete',
    repository: { root: '.', name: 'repository' },
    nodes: [
      {
        id: repositoryIdV2(),
        kind: 'repository',
        root: '.',
        name: 'repository',
      },
    ],
    edges: [],
    diagnostics: [],
  };
  let receivedOptions: unknown;
  const io = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        '/repo',
        '--snapshot-id',
        'csharp-options',
        '--language',
        'csharp',
        '--project',
        'App.csproj',
        '--source-encoding',
        'windows-1252',
        '--max-diagnostics',
        '100000',
        '--output',
        'json',
      ],
      injectedServices({
        discoverCSharpManifest: async () => ({ manifest, diagnostics: [] }),
        analyzeCSharpManifest: async (_root, _manifest, options) => {
          receivedOptions = options;
          return {
            projects: [],
            diagnostics: [
              {
                project: 'App.csproj',
                code: 'compiler_error',
                severity: 'error',
              },
              {
                project: 'App.csproj',
                code: 'compiler_warning',
                severity: 'warning',
              },
            ],
          };
        },
        extractCSharpDeclarationGraph: () => snapshot,
      }),
      io,
    ),
    0,
  );
  assert.deepEqual(receivedOptions, {
    sourceEncoding: 'windows-1252',
    maxDiagnostics: 100_000,
  });
  assert.deepEqual(JSON.parse(io.stdoutValue).result, {
    snapshotPath: '.sourcemesh/snapshots/csharp-options.json',
    completeness: 'complete',
    digest: 'a'.repeat(64),
    bytes: 12,
    handover:
      'Start a new MCP process with --snapshot .sourcemesh/snapshots/csharp-options.json; existing MCP processes remain pinned to their original snapshot.',
    compilerDiagnostics: { total: 2, errors: 1, warnings: 1 },
  });
});

test('query errors use exit code 3 and sanitized JSON envelopes', async () => {
  const services = injectedServices({
    createGraphQueryService: () =>
      ({
        searchSymbols: () => ({
          code: 'not_found',
          message: 'untrusted raw message',
          field: 'query',
        }),
      }) as unknown as GraphQueryService,
  });
  const io = capture();
  assert.equal(
    await main(
      [
        'symbol',
        '--root',
        '/repo',
        '--snapshot',
        '.sourcemesh/snapshots/query.json',
        '--query',
        'missing',
        '--output',
        'json',
      ],
      services,
      io,
    ),
    3,
  );
  assert.equal(io.stdoutValue, '');
  assert.deepEqual(JSON.parse(io.stderrValue), {
    schemaVersion: 1,
    command: 'symbol',
    error: {
      code: 'not_found',
      message: 'The requested graph item was not found.',
      field: 'query',
    },
  });
});

test('schema-v2 CLI query envelopes preserve the loaded version', async () => {
  const response = {
    operation: 'searchSymbols' as const,
    page: {
      schemaVersion: 2 as const,
      completeness: 'complete' as const,
      items: [],
      total: 0,
      truncated: false,
    },
  };
  const services = injectedServices({
    openValidatedSnapshot: async () => ({ schemaVersion: 2 }) as Snapshot,
    createGraphQueryService: () =>
      ({
        searchSymbols: () => response,
        getSymbol: () => response,
        listFileDependencies: () => ({ ...response }),
        listFileDependents: () => ({ ...response }),
        listCallers: () => ({ ...response }),
        listCallees: () => ({ ...response }),
      }) as unknown as GraphQueryServiceV2,
  });
  const successIO = capture();
  assert.equal(
    await main(
      [
        'symbol',
        '--root',
        '/repo',
        '--snapshot',
        '.sourcemesh/snapshots/query.json',
        '--query',
        'App',
        '--output',
        'json',
      ],
      services,
      successIO,
    ),
    0,
  );
  assert.equal(JSON.parse(successIO.stdoutValue).schemaVersion, 2);
});

test('real local analysis is queryable through all six operations and is deterministic', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.sourcemesh-cli-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"type":"module"}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'a.ts'),
    "import { target } from './b.js';\nexport function caller() { return target(); }\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'b.ts'),
    'export function target() { return 1; }\n',
    'utf8',
  );
  try {
    const analyzeIO = capture();
    assert.equal(
      await main(
        [
          'analyze',
          '--root',
          root,
          '--snapshot-id',
          'first',
          '--output',
          'json',
        ],
        undefined,
        analyzeIO,
      ),
      0,
    );
    const analyze = JSON.parse(analyzeIO.stdoutValue) as {
      result: { readonly snapshotPath: string };
    };
    assert.equal(
      analyze.result.snapshotPath,
      '.sourcemesh/snapshots/first.json',
    );
    assert.equal(analyzeIO.stdoutValue.includes(root), false);

    const duplicateIO = capture();
    assert.equal(
      await main(
        [
          'analyze',
          '--root',
          root,
          '--snapshot-id',
          'first',
          '--output',
          'json',
        ],
        undefined,
        duplicateIO,
      ),
      4,
    );
    assert.equal(duplicateIO.stdoutValue, '');
    assert.equal(
      JSON.parse(duplicateIO.stderrValue).error.code,
      'snapshot_conflict',
    );

    const snapshot = await openValidatedSnapshot(
      root,
      analyze.result.snapshotPath,
    );
    const caller = snapshot.nodes.find(
      (node) => node.kind === 'function' && node.name === 'caller',
    );
    const target = snapshot.nodes.find(
      (node) => node.kind === 'function' && node.name === 'target',
    );
    assert.ok(caller && target);

    const runQuery = async (args: string[]) => {
      const io = capture();
      assert.equal(
        await main(
          [
            ...args,
            '--snapshot',
            analyze.result.snapshotPath,
            '--allow-partial',
            '--output',
            'json',
          ],
          undefined,
          io,
        ),
        0,
      );
      assert.equal(io.stderrValue, '');
      return JSON.parse(io.stdoutValue) as { readonly result: QueryResponseV1 };
    };
    const firstSearch = await runQuery([
      'symbol',
      '--root',
      root,
      '--query',
      'caller',
    ]);
    const secondSearch = await runQuery([
      'symbol',
      '--root',
      root,
      '--query',
      'caller',
    ]);
    assert.equal(JSON.stringify(firstSearch), JSON.stringify(secondSearch));
    assert.equal(
      (firstSearch.result as SearchResponseV1).page.items[0]?.id,
      caller.id,
    );

    const details = await runQuery([
      'details',
      '--root',
      root,
      '--id',
      caller.id,
    ]);
    assert.equal((details.result as GetSymbolResponseV1).symbol.id, caller.id);

    const dependencies = await runQuery([
      'dependencies',
      '--root',
      root,
      '--file-id',
      fileId('a.ts'),
    ]);
    assert.equal(
      (dependencies.result as FileRelationResponseV1).page.items[0]?.path,
      'b.ts',
    );
    const dependents = await runQuery([
      'dependents',
      '--root',
      root,
      '--file-id',
      fileId('b.ts'),
    ]);
    assert.equal(
      (dependents.result as FileRelationResponseV1).page.items[0]?.path,
      'a.ts',
    );

    const callers = await runQuery([
      'callers',
      '--root',
      root,
      '--name',
      'target',
    ]);
    assert.equal(
      (callers.result as CallRelationResponseV1).page.items[0]?.name,
      'caller',
    );
    const callees = await runQuery([
      'callees',
      '--root',
      root,
      '--name',
      'caller',
    ]);
    assert.equal(
      (callees.result as CallRelationResponseV1).page.items[0]?.name,
      'target',
    );

    const overwriteIO = capture();
    assert.equal(
      await main(
        [
          'analyze',
          '--root',
          root,
          '--snapshot-id',
          'replacement',
          '--output',
          'json',
        ],
        undefined,
        overwriteIO,
      ),
      0,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
