import assert from 'node:assert/strict';
import { test } from 'node:test';

import { typescriptPack } from '../src/packs/typescript.js';

const encoder = new TextEncoder();

function request(files: Readonly<Record<string, string>>) {
  return {
    contractVersion: 1 as const,
    repository: { name: 'fixture', root: '.' as const },
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      contents: encoder.encode(contents),
    })),
    limits: {
      maxFiles: 10,
      maxBytes: 10_000,
      maxNodes: 1_000,
      maxEdges: 1_000,
      maxDiagnostics: 100,
    },
    configuration: {},
  };
}

test('TypeScript pack produces the established deterministic declaration graph fixture', async () => {
  const input = request({
    'caller.ts':
      "import { target } from './target.js';\nexport function caller() { return target(); }\n",
    'target.ts': 'export function target() { return 1; }\n',
  });

  const first = await typescriptPack.analyze(input);
  const second = await typescriptPack.analyze(input);

  assert.deepEqual(second.graph, first.graph);
  assert.equal(first.completeness, 'complete');
  assert.deepEqual(
    first.graph.nodes.map((node) => [
      node.kind,
      node.name,
      'path' in node ? node.path : undefined,
    ]),
    [
      ['file', 'caller.ts', 'caller.ts'],
      ['file', 'target.ts', 'target.ts'],
      ['function', 'caller', 'caller.ts'],
      ['function', 'target', 'target.ts'],
      ['module', 'caller.ts', 'caller.ts'],
      ['module', 'target.ts', 'target.ts'],
      ['repository', 'fixture', undefined],
    ],
  );
  assert.deepEqual(
    first.graph.edges.map((edge) => edge.kind),
    [
      'calls',
      'contains',
      'contains',
      'contains',
      'contains',
      'contains',
      'contains',
      'exports',
      'exports',
      'imports',
    ],
  );
});
