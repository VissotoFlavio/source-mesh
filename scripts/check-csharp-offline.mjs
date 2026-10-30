import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  analyzeCSharpManifest,
  CSharpWorkerError,
} from '../src/csharp/worker.ts';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const helper = path.join(
  repositoryRoot,
  'tools',
  'sourcemesh-roslyn',
  'bin',
  'Release',
  'net10.0',
  'sourcemesh-roslyn.dll',
);
const dotnetHost = 'C:\\Program Files\\dotnet\\dotnet.exe';

function invokeHelper(cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(dotnetHost, [helper], {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) =>
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
    child.stdin.end(input);
  });
}

if (process.platform !== 'win32') {
  throw new Error('The local Roslyn helper is supported only on Windows.');
}

const root = await fs.mkdtemp(path.join(tmpdir(), 'sourcemesh-roslyn-check-'));
try {
  for (const projects of [
    ['NotAProject.txt'],
    ['Cafe\u0301.csproj'],
    ['😀.csproj', '\uE000.csproj'],
  ]) {
    const response = await invokeHelper(
      root,
      `${JSON.stringify({
        version: 1,
        manifest: {
          language: 'csharp',
          selection: { version: 1, kind: 'explicit-projects', projects },
          projects: projects.map((path) => ({
            path,
            references: [],
            files: [],
          })),
        },
        sources: [],
      })}\n`,
    );
    assert.deepEqual(response, {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  }

  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'App.cs'),
    [
      'using System;',
      'using System.Collections.Generic;',
      'public class App',
      '{',
      '    public void Run() => Console.WriteLine(new List<string> { "ok" }.Count);',
      '}',
    ].join('\n'),
  );
  const manifest = {
    language: 'csharp',
    selection: { kind: 'project', path: 'App.csproj' },
    projects: [{ path: 'App.csproj', references: [], files: ['src/App.cs'] }],
  };
  const result = await analyzeCSharpManifest(root, manifest);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].path, 'App.csproj');
  assert.equal(result.projects[0].sourceCount, 1);
  assert.equal(result.projects[0].syntaxTreeCount, 1);
  assert.equal(result.projects[0].diagnosticCount, 0);
  assert.deepEqual(
    result.projects[0].declarations.map((item) => item.name),
    ['App', 'Run'],
  );
  assert.deepEqual(
    result.projects[0].relationships.map((item) => [item.kind, item.status]),
    [
      ['calls', 'external'],
      ['calls', 'unsupported'],
      ['uses', 'external'],
      ['uses', 'external'],
    ],
  );

  await fs.writeFile(
    path.join(root, 'src', 'App.cs'),
    [
      'namespace;',
      'public class Recovered {}',
      'class',
      '{',
      '    public class NestedRecovered {}',
      '}',
    ].join('\n'),
  );
  const malformedSyntaxResult = await analyzeCSharpManifest(root, manifest);
  const repeatedMalformedSyntaxResult = await analyzeCSharpManifest(
    root,
    manifest,
  );
  assert.deepEqual(
    malformedSyntaxResult.diagnostics,
    repeatedMalformedSyntaxResult.diagnostics,
  );
  assert.deepEqual(
    malformedSyntaxResult.diagnostics.map(
      ({ project, code, severity, path: file, line, column }) => ({
        project,
        code,
        severity,
        path: file,
        line,
        column,
      }),
    ),
    [
      {
        project: 'App.csproj',
        code: 'compiler_error',
        severity: 'error',
        path: 'src/App.cs',
        line: 1,
        column: 10,
      },
      {
        project: 'App.csproj',
        code: 'compiler_error',
        severity: 'error',
        path: 'src/App.cs',
        line: 3,
        column: 6,
      },
    ],
  );
  assert.equal(JSON.stringify(malformedSyntaxResult).includes(root), false);
  assert.deepEqual(
    malformedSyntaxResult.projects[0].declarations
      .map((item) => item.name)
      .filter((name) => name === 'Recovered' || name === 'NestedRecovered'),
    ['NestedRecovered', 'Recovered'],
  );

  await fs.writeFile(
    path.join(root, 'src', 'App.cs'),
    [
      'using System;',
      'using System.Collections.Generic;',
      'public class App',
      '{',
      '    public void Run() => Console.WriteLine(new List<string> { "ok" }.Count);',
      '}',
    ].join('\n'),
  );

  await fs.mkdir(path.join(root, 'src', 'Unlisted'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'Unlisted', 'Unlisted.csproj'),
    '<Project />',
  );
  const unlistedReferenceResult = await analyzeCSharpManifest(root, {
    ...manifest,
    projects: [
      {
        ...manifest.projects[0],
        references: ['src/Unlisted/Unlisted.csproj'],
      },
    ],
  });
  assert.deepEqual(unlistedReferenceResult.diagnostics, []);
  assert.equal(unlistedReferenceResult.projects.length, 1);
  assert.equal(unlistedReferenceResult.projects[0].path, 'App.csproj');

  await fs.writeFile(
    path.join(root, 'src', 'Selected.cs'),
    'public class Selected {}',
  );
  const explicitResult = await analyzeCSharpManifest(root, {
    language: 'csharp',
    selection: {
      version: 1,
      kind: 'explicit-projects',
      projects: ['App.csproj', 'Selected.csproj'],
    },
    projects: [
      {
        path: 'App.csproj',
        references: ['src/Unlisted/Unlisted.csproj'],
        files: ['src/App.cs'],
      },
      {
        path: 'Selected.csproj',
        references: [],
        files: ['src/Selected.cs'],
      },
    ],
  });
  assert.deepEqual(explicitResult.diagnostics, []);
  assert.deepEqual(
    explicitResult.projects.map((project) => project.path),
    ['App.csproj', 'Selected.csproj'],
  );

  await fs.writeFile(
    path.join(root, 'src', 'App.cs'),
    ['global using System;', 'public class Legacy {}'].join('\n'),
  );
  const legacyResult = await analyzeCSharpManifest(root, {
    ...manifest,
    projects: [
      {
        path: 'App.csproj',
        langVersion: '9.0',
        references: [],
        files: ['src/App.cs'],
      },
    ],
  });
  assert.ok(
    legacyResult.diagnostics.some(
      (diagnostic) => diagnostic.severity === 'error',
    ),
  );

  await fs.writeFile(
    path.join(root, 'src', 'App.cs'),
    Array.from(
      { length: 4097 },
      (_, index) => `#warning diagnostic-${index}`,
    ).join('\n'),
  );
  await assert.rejects(
    analyzeCSharpManifest(root, manifest),
    (error) =>
      error instanceof CSharpWorkerError && error.code === 'process_failed',
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

await fs.access(helper);
