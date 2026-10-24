import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeSnapshot,
  extractCSharpDeclarationGraph,
  type CSharpManifest,
  type CSharpWorkerProjectResult,
  type CSharpWorkerRelationship,
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

function worker(relationships: readonly CSharpWorkerRelationship[] = []): {
  readonly projects: readonly CSharpWorkerProjectResult[];
  readonly diagnostics: readonly [];
} {
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
    diagnostics: [],
  };
}

test('C# extraction emits a codec-valid v2 graph and preserves unresolved boundaries', () => {
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

  assert.equal(snapshot.schemaVersion, 2);
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
