import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  analyzeCSharpManifestForTest,
  CSHARP_WORKER_TIMEOUT_MS,
  CSharpWorkerError,
} from '../src/csharp/worker.js';
import type { CSharpManifest } from '../src/csharp/contracts.js';

let root = '';
let helper = '';
let host = '';
const manifest: CSharpManifest = {
  language: 'csharp',
  selection: { kind: 'project', path: 'App.csproj' },
  projects: [
    {
      path: 'App.csproj',
      references: [],
      files: ['src/App.cs'],
    },
  ],
};

before(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'csharp-worker-test-'));
  helper = path.join(root, 'helper', 'sourcemesh-roslyn.dll');
  host = path.join(root, 'trusted', 'dotnet.exe');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'App.cs'), 'class App {}');
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.writeFile(helper, 'test helper');
  await fs.mkdir(path.dirname(host), { recursive: true });
  await fs.writeFile(host, 'test host');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function runner(
  response: string,
  overrides: Partial<{
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> = {},
) {
  return async (invocation: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly input: string;
    readonly timeoutMs: number;
    readonly shell: boolean;
  }) => {
    assert.equal(invocation.command, host);
    assert.equal(invocation.args.length, 1);
    assert.equal(path.resolve(invocation.args[0]!), helper);
    assert.equal(invocation.shell, false);
    assert.equal(invocation.timeoutMs, CSHARP_WORKER_TIMEOUT_MS);
    const request = JSON.parse(invocation.input) as {
      readonly sources: readonly {
        readonly path: string;
        readonly staged: string;
      }[];
    };
    assert.deepEqual(request.sources, [
      { path: 'src/App.cs', staged: 'source-000000.cs' },
    ]);
    assert.equal(
      await fs.readFile(path.join(invocation.cwd, 'source-000000.cs'), 'utf8'),
      'class App {}',
    );
    await assert.rejects(fs.lstat(path.join(invocation.cwd, 'src')));
    return {
      stdout: Buffer.from(response),
      stderr: Buffer.from(overrides.stderr ?? ''),
      exitCode: overrides.exitCode ?? 0,
      timedOut: overrides.timedOut ?? false,
    };
  };
}

test('C# worker stages approved source files and accepts a deterministic response', async () => {
  const result = await analyzeCSharpManifestForTest(
    root,
    manifest,
    runner(
      '{"version":1,"projects":[{"path":"App.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0}],"diagnostics":[]}\n',
    ),
    helper,
    host,
  );
  assert.deepEqual(result, {
    projects: [
      {
        path: 'App.csproj',
        sourceCount: 1,
        syntaxTreeCount: 1,
        diagnosticCount: 0,
      },
    ],
    diagnostics: [],
  });
});

test('C# worker rejects malformed frames and helper failures', async () => {
  for (const [response, overrides] of [
    ['{}\n', {}],
    ['{"version":1,"projects":[],"diagnostics":[]}\nextra\n', {}],
    [
      '{"version":1,"projects":[],"diagnostics":[]}\n',
      { stderr: 'unexpected' },
    ],
    ['{"version":1,"projects":[],"diagnostics":[]}\n', { exitCode: 1 }],
    ['{"version":1,"projects":[],"diagnostics":[]}\n', { timedOut: true }],
  ] as const) {
    await assert.rejects(
      analyzeCSharpManifestForTest(
        root,
        manifest,
        runner(response, overrides),
        helper,
        host,
      ),
      CSharpWorkerError,
    );
  }
});

test('C# worker rejects manifest paths that could escape the staging root', async () => {
  const unsafe = {
    ...manifest,
    projects: [{ ...manifest.projects[0]!, files: ['../secret.cs'] }],
  };
  await assert.rejects(
    analyzeCSharpManifestForTest(root, unsafe, runner(''), helper, host),
    (error: unknown) =>
      error instanceof CSharpWorkerError && error.code === 'input_invalid',
  );
});

test('C# worker sanitizes temporary staging failures', async () => {
  let invoked = false;
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      manifest,
      async () => {
        invoked = true;
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          timedOut: false,
        };
      },
      helper,
      host,
      async () => {
        throw new Error('C:\\private\\temporary-directory');
      },
    ),
    (error: unknown) =>
      error instanceof CSharpWorkerError &&
      error.code === 'process_failed' &&
      error.message === 'The local C# analysis helper could not complete.',
  );
  assert.equal(invoked, false);
});

test('C# worker rejects duplicate references and Windows-unsafe logical paths', async () => {
  const duplicateReferences: CSharpManifest = {
    ...manifest,
    projects: [
      {
        path: 'App.csproj',
        references: ['Library.csproj', 'Library.csproj'],
        files: ['src/App.cs'],
      },
      { path: 'Library.csproj', references: [], files: ['src/App.cs'] },
    ],
  };
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      duplicateReferences,
      runner(''),
      helper,
      host,
    ),
    (error: unknown) =>
      error instanceof CSharpWorkerError && error.code === 'input_invalid',
  );
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      { ...manifest, selection: { kind: 'project', path: 'C:App.csproj' } },
      runner(''),
      helper,
      host,
    ),
    (error: unknown) =>
      error instanceof CSharpWorkerError && error.code === 'input_invalid',
  );
});

test('C# worker uses an opaque flat staging layout for nested logical paths', async () => {
  await fs.mkdir(path.join(root, 'nested', 'input'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'nested', 'input', 'App.cs'),
    'class Nested {}',
  );
  const nestedManifest: CSharpManifest = {
    ...manifest,
    projects: [{ ...manifest.projects[0]!, files: ['nested/input/App.cs'] }],
  };
  await analyzeCSharpManifestForTest(
    root,
    nestedManifest,
    async (invocation) => {
      const request = JSON.parse(invocation.input) as {
        readonly sources: readonly {
          readonly path: string;
          readonly staged: string;
        }[];
      };
      assert.deepEqual(request.sources, [
        { path: 'nested/input/App.cs', staged: 'source-000000.cs' },
      ]);
      assert.equal(
        await fs.readFile(
          path.join(invocation.cwd, 'source-000000.cs'),
          'utf8',
        ),
        'class Nested {}',
      );
      await assert.rejects(fs.lstat(path.join(invocation.cwd, 'nested')));
      return {
        stdout: Buffer.from(
          '{"version":1,"projects":[{"path":"App.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0}],"diagnostics":[]}\n',
        ),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
      };
    },
    helper,
    host,
  );
});

test('C# worker rejects a substituted source-directory link without touching its target', async (t) => {
  const linkedRoot = await fs.mkdtemp(
    path.join(tmpdir(), 'csharp-worker-linked-'),
  );
  const outside = await fs.mkdtemp(
    path.join(tmpdir(), 'csharp-worker-outside-'),
  );
  try {
    await fs.writeFile(path.join(outside, 'App.cs'), 'class Outside {}');
    try {
      await fs.symlink(outside, path.join(linkedRoot, 'src'), 'junction');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('junction creation is unavailable on this host');
        return;
      }
      throw error;
    }
    let invoked = false;
    await assert.rejects(
      analyzeCSharpManifestForTest(
        linkedRoot,
        manifest,
        async () => {
          invoked = true;
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            timedOut: false,
          };
        },
        helper,
        host,
      ),
      (error: unknown) =>
        error instanceof CSharpWorkerError && error.code === 'input_invalid',
    );
    assert.equal(invoked, false);
    assert.equal(
      await fs.readFile(path.join(outside, 'App.cs'), 'utf8'),
      'class Outside {}',
    );
  } finally {
    await fs.rm(linkedRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('C# worker rejects oversized frames, unsorted diagnostics, and repeated source references', async () => {
  const response =
    '{"version":1,"projects":[{"path":"App.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":2}],"diagnostics":[{"project":"App.csproj","code":"compiler_error","severity":"error","path":"src/App.cs","line":2,"column":1},{"project":"App.csproj","code":"compiler_error","severity":"error","path":"src/App.cs","line":1,"column":1}]}\n';
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      manifest,
      runner(response),
      helper,
      host,
    ),
    CSharpWorkerError,
  );
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      manifest,
      runner('x'.repeat(2 * 1024 * 1024 + 1)),
      helper,
      host,
    ),
    CSharpWorkerError,
  );
  const excessiveDiagnostics =
    JSON.stringify({
      version: 1,
      projects: [],
      diagnostics: Array.from({ length: 4097 }, () => null),
    }) + '\n';
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      manifest,
      runner(excessiveDiagnostics),
      helper,
      host,
    ),
    CSharpWorkerError,
  );
  const repeated = {
    ...manifest,
    projects: Array.from({ length: 2 }, (_, index) => ({
      path: `App${index}.csproj`,
      references: [],
      files: Array.from(
        { length: 10_000 },
        (_, file) => `src/App${index}-${file}.cs`,
      ),
    })),
  };
  await assert.rejects(
    analyzeCSharpManifestForTest(root, repeated, runner(''), helper, host),
    CSharpWorkerError,
  );
  assert.equal(await fs.readFile(helper, 'utf8'), 'test helper');
});

test('C# worker uses ordinal ordering and a trusted host outside the staged cwd', async () => {
  await fs.writeFile(path.join(root, 'dotnet.exe'), 'staged decoy');
  const unicode: CSharpManifest = {
    ...manifest,
    selection: { kind: 'project', path: 'z.csproj' },
    projects: [
      { path: 'z.csproj', references: [], files: ['src/App.cs'] },
      { path: 'ä.csproj', references: [], files: ['src/App.cs'] },
    ],
  };
  const ordered =
    '{"version":1,"projects":[{"path":"z.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0},{"path":"ä.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0}],"diagnostics":[]}\n';
  await analyzeCSharpManifestForTest(
    root,
    unicode,
    async (invocation) => {
      assert.equal(invocation.command, host);
      assert.notEqual(
        invocation.command,
        path.join(invocation.cwd, 'dotnet.exe'),
      );
      return {
        stdout: Buffer.from(ordered),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
      };
    },
    helper,
    host,
  );
  const localeOrdered = ordered.replace(
    '"z.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0},{"path":"ä.csproj"',
    '"ä.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0},{"path":"z.csproj"',
  );
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      unicode,
      runner(localeOrdered),
      helper,
      host,
    ),
    CSharpWorkerError,
  );
});
