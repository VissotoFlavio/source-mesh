import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  analyzeCSharpManifestForTest,
  CSHARP_WORKER_MAX_TIMEOUT_MS,
  CSharpWorkerError,
} from '../src/csharp/worker.js';
import { discoverCSharpExplicitProjectManifest } from '../src/csharp/discovery.js';
import { createCSharpExplicitProjectSelection } from '../src/csharp/contracts.js';
import type { CSharpExplicitProjectManifest } from '../src/csharp/contracts.js';

let root = '';
let helper = '';
let host = '';
const manifest: CSharpExplicitProjectManifest = {
  language: 'csharp',
  selection: {
    version: 1,
    kind: 'explicit-projects',
    projects: ['App.csproj'],
  },
  projects: [
    {
      path: 'App.csproj',
      references: [],
      files: ['src/App.cs'],
    },
  ],
};

const explicitManifest: CSharpExplicitProjectManifest = {
  language: 'csharp',
  selection: {
    version: 1,
    kind: 'explicit-projects',
    projects: ['App.csproj', 'Library.csproj'],
  },
  projects: [
    {
      path: 'App.csproj',
      references: ['Library.csproj'],
      files: ['src/App.cs'],
    },
    {
      path: 'Library.csproj',
      references: [],
      files: ['src/Library.cs'],
    },
  ],
};

before(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'csharp-worker-test-')),
  );
  helper = path.join(root, 'helper', 'sourcemesh-roslyn.dll');
  host = path.join(root, 'trusted', 'dotnet.exe');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'App.cs'), 'class App {}');
  await fs.writeFile(path.join(root, 'src', 'Library.cs'), 'class Library {}');
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
  expectedTimeout?: number,
) {
  return async (invocation: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly input: string;
    readonly timeoutMs?: number;
    readonly shell: boolean;
  }) => {
    assert.equal(invocation.command, host);
    assert.equal(invocation.args.length, 1);
    assert.equal(path.resolve(invocation.args[0]!), helper);
    assert.equal(invocation.shell, false);
    assert.equal(invocation.timeoutMs, expectedTimeout);
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

test('C# worker forwards an explicit selection without adding referenced projects', async () => {
  const result = await analyzeCSharpManifestForTest(
    root,
    explicitManifest,
    async (invocation) => {
      const request = JSON.parse(invocation.input) as {
        readonly manifest: unknown;
        readonly sources: unknown;
      };
      assert.deepEqual(request.manifest, explicitManifest);
      assert.deepEqual(request.sources, [
        { path: 'src/App.cs', staged: 'source-000000.cs' },
        { path: 'src/Library.cs', staged: 'source-000001.cs' },
      ]);
      return {
        stdout: Buffer.from(
          '{"version":1,"projects":[{"path":"App.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0},{"path":"Library.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0}],"diagnostics":[]}\n',
        ),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
      };
    },
    helper,
    host,
  );
  assert.deepEqual(
    result.projects.map((project) => project.path),
    ['App.csproj', 'Library.csproj'],
  );
});

test('C# explicit selection keeps UTF-8 project order through discovery and worker preflight', async () => {
  const astralProject = '😀/Astral.csproj';
  const bmpProject = '\uE000/Bmp.csproj';
  const projectSources: readonly (readonly [string, string])[] = [
    [astralProject, '😀/Astral.cs'],
    [bmpProject, '\uE000/Bmp.cs'],
  ];
  for (const [project, source] of projectSources) {
    await fs.mkdir(path.dirname(path.join(root, ...project.split('/'))), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, ...project.split('/')), '<Project />');
    await fs.writeFile(
      path.join(root, ...source.split('/')),
      'public class Marker {}',
    );
  }
  const selection = createCSharpExplicitProjectSelection([
    astralProject,
    bmpProject,
  ]);
  assert.ok('selection' in selection);
  assert.deepEqual(selection.selection.projects, [bmpProject, astralProject]);
  const discovered = await discoverCSharpExplicitProjectManifest(
    root,
    selection.selection,
  );
  assert.ok(discovered.manifest);

  let invoked = false;
  await analyzeCSharpManifestForTest(
    root,
    discovered.manifest,
    async (invocation) => {
      invoked = true;
      const request = JSON.parse(invocation.input) as {
        readonly manifest: CSharpExplicitProjectManifest;
      };
      assert.deepEqual(request.manifest.selection.projects, [
        bmpProject,
        astralProject,
      ]);
      return {
        stdout: Buffer.from(
          `${JSON.stringify({
            version: 1,
            projects: [
              {
                path: bmpProject,
                sourceCount: 1,
                syntaxTreeCount: 1,
                diagnosticCount: 0,
              },
              {
                path: astralProject,
                sourceCount: 1,
                syntaxTreeCount: 1,
                diagnosticCount: 0,
              },
            ],
            diagnostics: [],
          })}\n`,
        ),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
      };
    },
    helper,
    host,
  );
  assert.equal(invoked, true);
});

test('C# worker rejects explicit selections that do not exactly name the manifest projects', async () => {
  const invalid = {
    ...explicitManifest,
    selection: {
      ...explicitManifest.selection,
      projects: ['App.csproj'],
    },
  };
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      invalid,
      async () => {
        throw new Error('runner must not start');
      },
      helper,
      host,
    ),
    (error: unknown) =>
      error instanceof CSharpWorkerError && error.code === 'input_invalid',
  );
});

test('C# worker applies a timeout only when an automation explicitly requests one', async () => {
  await analyzeCSharpManifestForTest(
    root,
    manifest,
    runner(
      '{"version":1,"projects":[{"path":"App.csproj","sourceCount":1,"syntaxTreeCount":1,"diagnosticCount":0}],"diagnostics":[]}\n',
      {},
      30_000,
    ),
    helper,
    host,
    undefined,
    { timeoutMs: 30_000 },
  );
});

test('C# worker rejects an invalid explicit automation timeout', async () => {
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      manifest,
      async () => {
        throw new Error('runner must not start');
      },
      helper,
      host,
      undefined,
      { timeoutMs: CSHARP_WORKER_MAX_TIMEOUT_MS + 1 },
    ),
    (error: unknown) =>
      error instanceof CSharpWorkerError && error.code === 'resource_limit',
  );
});

test('C# worker reads bounded disk chunks and merges them deterministically', async () => {
  let staging = '';
  const parent = {
    kind: 'module',
    path: 'src/App.cs',
    name: 'src/App.cs',
    qualifiedName: 'src/App.cs',
    memberRole: 'none',
  };
  const declaration = {
    kind: 'class',
    path: 'src/App.cs',
    name: 'App',
    qualifiedName: 'App',
    memberRole: 'none',
    parent,
    locations: [
      {
        path: 'src/App.cs',
        start: { line: 1, column: 1 },
        end: { line: 1, column: 11 },
      },
    ],
  };
  const functionDeclaration = {
    ...declaration,
    kind: 'function',
    name: 'Run',
    qualifiedName: 'App.Run',
    parent: {
      kind: 'class',
      path: 'src/App.cs',
      name: 'App',
      qualifiedName: 'App',
      memberRole: 'none',
    },
  };
  await analyzeCSharpManifestForTest(
    root,
    manifest,
    async (invocation) => {
      const makeChunk = (project: Record<string, unknown>) =>
        JSON.stringify({ version: 1, project, diagnostics: [] });
      const first = makeChunk({
        path: 'App.csproj',
        sourceCount: 1,
        syntaxTreeCount: 1,
        diagnosticCount: 0,
        declarations: [declaration],
        relationships: [],
      });
      const second = makeChunk({
        path: 'App.csproj',
        sourceCount: 1,
        syntaxTreeCount: 1,
        diagnosticCount: 0,
        declarations: [functionDeclaration],
        relationships: [],
      });
      await fs.writeFile(path.join(invocation.cwd, 'chunk-000000.json'), first);
      await fs.writeFile(
        path.join(invocation.cwd, 'chunk-000001.json'),
        second,
      );
      const response = JSON.stringify({
        version: 2,
        chunks: [
          {
            index: 0,
            project: 'App.csproj',
            bytes: Buffer.byteLength(first),
          },
          {
            index: 1,
            project: 'App.csproj',
            bytes: Buffer.byteLength(second),
          },
        ],
      });
      return {
        stdout: Buffer.from(`${response}\n`),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
      };
    },
    helper,
    host,
    async (prefix) => {
      staging = await fs.mkdtemp(prefix);
      return staging;
    },
  ).then((result) => {
    assert.deepEqual(
      result.projects[0]?.declarations?.map((item) => item.name),
      ['App', 'Run'],
    );
  });
  await assert.rejects(fs.lstat(staging));
});

test('C# worker fails closed when the trusted helper or runtime host is missing', async () => {
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      manifest,
      runner(''),
      path.join(root, 'missing', 'sourcemesh-roslyn.dll'),
      host,
    ),
    (error: unknown) =>
      error instanceof CSharpWorkerError && error.code === 'helper_missing',
  );
  await assert.rejects(
    analyzeCSharpManifestForTest(
      root,
      manifest,
      runner(''),
      helper,
      path.join(root, 'missing', 'dotnet.exe'),
    ),
    (error: unknown) =>
      error instanceof CSharpWorkerError && error.code === 'helper_missing',
  );
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
  const duplicateReferences: CSharpExplicitProjectManifest = {
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
      {
        ...manifest,
        selection: {
          ...manifest.selection,
          projects: ['C:App.csproj'],
        },
      },
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
  const nestedManifest: CSharpExplicitProjectManifest = {
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
  const unicode: CSharpExplicitProjectManifest = {
    ...manifest,
    selection: {
      version: 1,
      kind: 'explicit-projects',
      projects: ['z.csproj', 'ä.csproj'],
    },
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
