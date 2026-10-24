import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  analyzeCSharpManifest,
  CSharpWorkerError,
} from '../src/csharp/worker.ts';

if (process.platform !== 'win32') {
  throw new Error('The local Roslyn helper is supported only on Windows.');
}

const root = await fs.mkdtemp(path.join(tmpdir(), 'sourcemesh-roslyn-check-'));
try {
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
await fs.access(helper);
