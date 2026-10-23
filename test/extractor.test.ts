import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  edgeId,
  encodeSnapshot,
  extractDeclarationGraph,
  loadProject,
  nodeId,
  repositoryId,
} from '../src/index.js';

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-extractor-'));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  const loaded = loadProject({
    repositoryRoot: root,
    approvedFiles: Object.keys(files).sort(),
  });
  assert.ok(loaded.project, JSON.stringify(loaded.diagnostics));
  return { root, loaded: loaded.project };
}

test('extracts the closed declaration set with direct containment only', () => {
  const { root, loaded } = project({
    'src/index.ts': `
      export interface User { id: string; save(value: string): void; }
      export class Service { static count: number; value: string; static create(value: string) { return value; } run(value: string) { return value; } }
      export function work(value: string): string { return value; }
      export const arrow = (value: string) => value;
      export type Name = string;
      export namespace Api { export function list(value: number) { return value; } }
    `,
    'src/other.js': 'export class Other { method(value) { return value; } }\n',
  });
  const graph = extractDeclarationGraph({
    repositoryRoot: root,
    project: loaded,
  });
  assert.equal(graph.repository.name, 'repository');
  assert.equal(graph.repository.root, '.');
  assert.ok(
    graph.nodes.some(
      (node) => node.kind === 'interface' && node.name === 'User',
    ),
  );
  assert.ok(
    graph.nodes.some(
      (node) => node.kind === 'class' && node.name === 'Service',
    ),
  );
  assert.ok(
    graph.nodes.some((node) => node.kind === 'type' && node.name === 'Name'),
  );
  assert.ok(
    graph.nodes.some(
      (node) => node.kind === 'parameter' && node.name === 'value',
    ),
  );
  assert.ok(
    graph.nodes.some((node) => node.kind === 'module' && node.name === 'Api'),
  );
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.kind === 'function' &&
        node.name === 'create' &&
        node.memberRole === 'static',
    ),
  );
  const interfaceNode = graph.nodes.find(
    (node) => node.kind === 'interface' && node.name === 'User',
  );
  const interfaceMethod = graph.nodes.find(
    (node) =>
      node.kind === 'function' &&
      node.name === 'save' &&
      node.memberRole === 'instance',
  );
  const interfaceProperty = graph.nodes.find(
    (node) =>
      node.kind === 'variable' &&
      node.name === 'id' &&
      node.memberRole === 'instance',
  );
  assert.ok(interfaceNode && interfaceNode.kind === 'interface');
  assert.ok(interfaceMethod && interfaceMethod.kind === 'function');
  assert.ok(interfaceProperty && interfaceProperty.kind === 'variable');
  assert.ok(
    interfaceMethod &&
      graph.edges.some(
        (edge) =>
          edge.kind === 'contains' &&
          edge.from === interfaceNode?.id &&
          edge.to === interfaceMethod.id,
      ),
  );
  assert.ok(
    interfaceProperty &&
      graph.edges.some(
        (edge) =>
          edge.kind === 'contains' &&
          edge.from === interfaceNode?.id &&
          edge.to === interfaceProperty.id,
      ),
  );
  const serviceNode = graph.nodes.find(
    (node) => node.kind === 'class' && node.name === 'Service',
  );
  const staticProperty = graph.nodes.find(
    (node) => node.kind === 'variable' && node.name === 'count',
  );
  const instanceProperty = graph.nodes.find(
    (node) => node.kind === 'variable' && node.name === 'value',
  );
  assert.ok(serviceNode && serviceNode.kind === 'class');
  assert.ok(staticProperty && staticProperty.kind === 'variable');
  assert.ok(instanceProperty && instanceProperty.kind === 'variable');
  if (
    serviceNode?.kind !== 'class' ||
    staticProperty?.kind !== 'variable' ||
    instanceProperty?.kind !== 'variable'
  )
    throw new Error('expected class and property nodes');
  assert.equal(staticProperty.memberRole, 'static');
  assert.equal(instanceProperty.memberRole, 'instance');
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.id === edgeId('contains', serviceNode.id, staticProperty.id) &&
        edge.from === serviceNode.id &&
        edge.to === staticProperty.id,
    ),
  );
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.kind === 'function' &&
        node.name === 'run' &&
        node.memberRole === 'instance',
    ),
  );
  assert.ok(graph.nodes.every((node) => !JSON.stringify(node).includes(root)));
  assert.ok(
    graph.nodes.every(
      (node) => !JSON.stringify(node).includes('export interface'),
    ),
  );
  assert.ok(
    graph.edges.every((edge) => ['contains', 'exports'].includes(edge.kind)),
  );
  assert.equal(graph.nodes.filter((node) => node.kind === 'file').length, 2);
  assert.equal(graph.nodes.filter((node) => node.kind === 'module').length, 3);
  const repositoryNode = graph.nodes.find((node) => node.kind === 'repository');
  assert.ok(repositoryNode);
  assert.equal(repositoryNode.id, repositoryId());
});

test('emits snapshot-valid identities for interface methods and properties', () => {
  const { root, loaded } = project({
    'src/contracts.ts': `
      export interface Contract {
        value: string;
        run(input: string): void;
      }
    `,
  });
  const graph = extractDeclarationGraph({
    repositoryRoot: root,
    project: loaded,
  });

  assert.doesNotThrow(() =>
    encodeSnapshot({ ...graph, completeness: 'complete' }),
  );
});

test('identity and ordering are independent of approved root order and comments', () => {
  const first = project({
    'src/a.ts': 'export function run(value: string) { return value; }\n',
    'src/b.ts': 'export const value = 1;\n',
  });
  const second = loadProject({
    repositoryRoot: first.root,
    approvedFiles: ['src/b.ts', 'src/a.ts'],
  });
  assert.ok(second.project);
  const left = extractDeclarationGraph({
    repositoryRoot: first.root,
    project: first.loaded,
  });
  const right = extractDeclarationGraph({
    repositoryRoot: first.root,
    project: {
      ...second.project,
      rootNames: [...second.project.rootNames].reverse(),
    },
  });
  assert.deepEqual(left, right);
  assert.ok(
    left.nodes.every((node) => !('parent' in node) && !('container' in node)),
  );
  assert.ok(
    left.nodes.every((node) => !JSON.stringify(node).match(/[A-Z]:\\|\\\\/u)),
  );
});

test('canonical generic signatures ignore comments, whitespace, and root order', () => {
  const first = project({
    'src/generic.ts': `
      function make< T extends string = string >(value: T): T { return value; }
      class Box< T extends string = string > { value: T; }
      interface Result< T extends string = string > { value: T; }
      type Maybe< T = string > = T | undefined;
    `,
    'src/other.ts': 'export const other = 1;\n',
  });
  const second = project({
    'src/generic.ts': `// declarations retain only semantic signatures
      function make<T extends string = string>( value: T ): T { return value; }
      class Box<T extends string = string>{value:T}
      interface Result<T extends string = string>{value:T}
      type Maybe<T=string> = T|undefined;
    `,
    'src/other.ts': 'export const other = 1;\n',
  });
  const firstGraph = extractDeclarationGraph({
    repositoryRoot: first.root,
    project: first.loaded,
  });
  const secondGraph = extractDeclarationGraph({
    repositoryRoot: second.root,
    project: {
      ...second.loaded,
      rootNames: [...second.loaded.rootNames].reverse(),
    },
  });
  const nodeIdentity = (graph: ReturnType<typeof extractDeclarationGraph>) =>
    graph.nodes.map((node) => {
      if (node.kind === 'repository')
        return { id: node.id, kind: node.kind, name: node.name };
      if (node.kind === 'file')
        return {
          id: node.id,
          kind: node.kind,
          name: node.name,
          path: node.path,
        };
      return {
        id: node.id,
        kind: node.kind,
        name: node.name,
        path: node.path,
        qualifiedName: node.qualifiedName,
        memberRole: node.memberRole,
      };
    });
  assert.deepEqual(nodeIdentity(firstGraph), nodeIdentity(secondGraph));
  assert.deepEqual(
    firstGraph.edges.map(({ id, kind, from, to }) => ({ id, kind, from, to })),
    secondGraph.edges.map(({ id, kind, from, to }) => ({ id, kind, from, to })),
  );
  assert.deepEqual(
    firstGraph,
    extractDeclarationGraph({
      repositoryRoot: first.root,
      project: first.loaded,
    }),
  );
});

test('omits every node in a deterministic identity collision', () => {
  const { root, loaded } = project({
    'src/collision.ts': 'function first() {}\nfunction second() {}\n',
  });
  const identity = {
    nodeId: (
      kind: Parameters<typeof nodeId>[0],
      relativePath: string,
      parentPath: string,
      name: string,
      role: Parameters<typeof nodeId>[4],
    ) =>
      kind === 'function'
        ? 'n:forced-collision'
        : nodeId(kind, relativePath, parentPath, name, role),
  };
  const graph = extractDeclarationGraph({
    repositoryRoot: root,
    project: loaded,
    identity,
  });
  const repeated = extractDeclarationGraph({
    repositoryRoot: root,
    project: loaded,
    identity,
  });
  assert.deepEqual(graph, repeated);
  assert.equal(
    graph.nodes.filter(
      (node) =>
        node.kind === 'function' && ['first', 'second'].includes(node.name),
    ).length,
    0,
  );
  assert.equal(
    graph.edges.filter((edge) => edge.to === 'n:forced-collision').length,
    0,
  );
  assert.equal(
    graph.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'graph.node_id_collision',
    ).length,
    1,
  );
});
