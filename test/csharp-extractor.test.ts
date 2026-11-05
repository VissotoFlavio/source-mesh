import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeSnapshot,
  extractCSharpDeclarationGraph,
  type CSharpExplicitProjectManifest,
  type CSharpManifest,
  type CSharpWorkerRelationship,
  type CSharpWorkerResult,
  type CSharpWorkerSymbol,
} from '../src/index.js';

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

const explicitManifest: CSharpExplicitProjectManifest = {
  language: 'csharp',
  selection: {
    version: 1,
    kind: 'explicit-projects',
    projects: ['src/App/App.csproj', 'src/Tools/Tools.csproj'],
  },
  projects: [
    {
      path: 'src/App/App.csproj',
      references: ['src/Lib/Lib.csproj'],
      files: ['src/App/App.cs'],
    },
    {
      path: 'src/Tools/Tools.csproj',
      references: [],
      files: ['src/Tools/Tools.cs'],
    },
  ],
};

function symbol(
  kind: CSharpWorkerSymbol['kind'],
  name: string,
  qualifiedName: string,
  memberRole: CSharpWorkerSymbol['memberRole'] = 'none',
): CSharpWorkerSymbol {
  return {
    kind,
    path: 'src/App.cs',
    name,
    qualifiedName,
    memberRole,
  };
}

const module = symbol('module', 'src/App.cs', 'src/App.cs');
const namespace = symbol('namespace', 'App', 'App');
const app = symbol('class', 'App', 'App.App');
const run = symbol('function', 'Run', 'App.App.Run', 'instance');
const parameter = symbol('parameter', 'value', 'App.App.Run.value');

const declaration = (
  value: CSharpWorkerSymbol,
  parent: CSharpWorkerSymbol,
  line: number,
) => ({
  ...value,
  parent,
  locations: [
    {
      path: 'src/App.cs',
      start: { line, column: 1 },
      end: { line, column: 10 },
    },
  ],
});

function worker(
  relationships: readonly CSharpWorkerRelationship[] = [],
  diagnostics: CSharpWorkerResult['diagnostics'] = [],
): CSharpWorkerResult {
  return {
    projects: [
      {
        path: 'App.csproj',
        sourceCount: 1,
        syntaxTreeCount: 1,
        diagnosticCount: 0,
        declarations: [
          declaration(namespace, module, 1),
          declaration(app, namespace, 2),
          declaration(run, app, 3),
          declaration(parameter, run, 4),
        ],
        relationships,
      },
    ],
    diagnostics,
  };
}

test('C# extraction emits a codec-valid v3 graph with syntactic evidence and preserves unresolved boundaries', () => {
  const snapshot = extractCSharpDeclarationGraph({
    repositoryRoot: 'C:/one',
    manifest,
    worker: worker([
      {
        kind: 'calls',
        status: 'external',
        source: run,
        location: {
          path: 'src/App.cs',
          start: { line: 5, column: 1 },
          end: { line: 5, column: 8 },
        },
      },
    ]),
  });

  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.completeness, 'complete');
  assert.deepEqual(
    snapshot.nodes.map((node) => node.kind),
    [
      'class',
      'file',
      'function',
      'module',
      'namespace',
      'parameter',
      'project',
      'repository',
    ],
  );
  assert.equal(
    snapshot.edges.some((edge) => edge.kind === 'calls'),
    false,
  );
  assert.equal(
    snapshot.diagnostics.some(
      (diagnostic) => diagnostic.code === 'relationship_external',
    ),
    true,
  );
  assert.equal(snapshot.metadata.packs[0]?.id, 'csharp');
  assert.doesNotThrow(() => encodeSnapshot(snapshot));
});

test('C# extraction is independent of repository roots and worker order', () => {
  const first = extractCSharpDeclarationGraph({
    repositoryRoot: 'C:/one',
    manifest,
    worker: worker(),
  });
  const second = extractCSharpDeclarationGraph({
    repositoryRoot: 'D:/two',
    manifest,
    worker: worker(),
  });
  assert.deepEqual(encodeSnapshot(first), encodeSnapshot(second));
});

test('C# explicit selections compose one deterministic snapshot without adding external references', () => {
  const project = (path: string) => ({
    path,
    sourceCount: 1,
    syntaxTreeCount: 1,
    diagnosticCount: 0,
  });
  const first = extractCSharpDeclarationGraph({
    repositoryRoot: 'C:/one',
    manifest: explicitManifest,
    worker: {
      projects: [
        project('src/Tools/Tools.csproj'),
        project('src/App/App.csproj'),
      ],
      diagnostics: [],
    },
  });
  const second = extractCSharpDeclarationGraph({
    repositoryRoot: 'D:/two',
    manifest: explicitManifest,
    worker: {
      projects: [
        project('src/App/App.csproj'),
        project('src/Tools/Tools.csproj'),
      ],
      diagnostics: [],
    },
  });

  assert.deepEqual(encodeSnapshot(first), encodeSnapshot(second));
  assert.deepEqual(
    first.nodes
      .flatMap((node) => (node.kind === 'project' ? [node.path] : []))
      .sort(),
    ['src/App/App.csproj', 'src/Tools/Tools.csproj'],
  );
  assert.ok(
    first.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'relationship_unresolved' &&
        diagnostic.relationKind === 'references',
    ),
  );
});

test('C# extraction does not make a structurally complete graph partial for legacy worker diagnostics', () => {
  const snapshot = extractCSharpDeclarationGraph({
    repositoryRoot: 'C:/one',
    manifest,
    worker: worker(
      [],
      [
        {
          project: 'App.csproj',
          code: 'compiler_error',
          severity: 'error',
          path: 'src/App.cs',
          line: 1,
          column: 1,
        },
      ],
    ),
  });

  assert.equal(snapshot.completeness, 'complete');
});

test('C# structural identity collisions keep the graph partial', () => {
  const firstFunction = symbol('function', 'Run', 'App.App.Run(System.Int32)');
  const secondFunction = symbol(
    'function',
    'Run',
    'App.App.Run(System.String)',
  );
  const firstParameter = symbol('parameter', 'value', 'App.App.Run.value');
  const secondParameter = symbol('parameter', 'value', 'App.App.Run.value');
  const collisionWorker: CSharpWorkerResult = {
    projects: [
      {
        path: 'App.csproj',
        sourceCount: 1,
        syntaxTreeCount: 1,
        diagnosticCount: 0,
        declarations: [
          declaration(firstFunction, app, 3),
          declaration(secondFunction, app, 4),
          declaration(firstParameter, firstFunction, 5),
          declaration(secondParameter, secondFunction, 6),
        ],
      },
    ],
    diagnostics: [],
  };

  const snapshot = extractCSharpDeclarationGraph({
    repositoryRoot: 'C:/one',
    manifest,
    worker: collisionWorker,
  });

  assert.equal(snapshot.completeness, 'partial');
  assert.ok(
    snapshot.diagnostics.some(
      (diagnostic) => diagnostic.code === 'graph.node_id_collision',
    ),
  );
});
