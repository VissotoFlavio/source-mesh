import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  createGraphQueryService,
  edgeId,
  fileId,
  nodeId,
  repositoryId,
  type QueryErrorV1,
  type QueryResponseV1,
  type SnapshotV1,
} from '../src/index.js';

export function fixture(
  completeness: SnapshotV1['completeness'] = 'complete',
): SnapshotV1 {
  const repository = {
    id: repositoryId(),
    kind: 'repository' as const,
    root: '.' as const,
    name: 'repository',
  };
  const fileA = {
    id: fileId('src/a.ts'),
    kind: 'file' as const,
    name: 'a.ts',
    path: 'src/a.ts',
  };
  const fileB = {
    id: fileId('src/b.ts'),
    kind: 'file' as const,
    name: 'b.ts',
    path: 'src/b.ts',
  };
  const moduleScope = (file: typeof fileA) =>
    `${repository.id}/${file.id}#scope=root`;
  const moduleA = {
    id: nodeId('module', fileA.path, moduleScope(fileA), 'a', 'none'),
    kind: 'module' as const,
    name: 'a',
    path: fileA.path,
    qualifiedName: 'a',
    memberRole: 'none' as const,
  };
  const moduleB = {
    id: nodeId('module', fileB.path, moduleScope(fileB), 'b', 'none'),
    kind: 'module' as const,
    name: 'b',
    path: fileB.path,
    qualifiedName: 'b',
    memberRole: 'none' as const,
  };
  const symbolScope = (module: typeof moduleA) =>
    `${repository.id}/${module === moduleA ? fileA.id : fileB.id}/${module.id}#scope=module:${module.qualifiedName}`;
  const caller = {
    id: nodeId('function', fileA.path, symbolScope(moduleA), 'caller', 'none'),
    kind: 'function' as const,
    name: 'caller',
    path: fileA.path,
    qualifiedName: 'caller',
    memberRole: 'none' as const,
  };
  const callee = {
    id: nodeId('function', fileB.path, symbolScope(moduleB), 'callee', 'none'),
    kind: 'function' as const,
    name: 'callee',
    path: fileB.path,
    qualifiedName: 'callee',
    memberRole: 'none' as const,
  };
  const sharedA = {
    id: nodeId('function', fileA.path, symbolScope(moduleA), 'shared', 'none'),
    kind: 'function' as const,
    name: 'shared',
    path: fileA.path,
    qualifiedName: 'shared',
    memberRole: 'none' as const,
  };
  const sharedB = {
    id: nodeId('function', fileB.path, symbolScope(moduleB), 'shared', 'none'),
    kind: 'function' as const,
    name: 'shared',
    path: fileB.path,
    qualifiedName: 'shared',
    memberRole: 'none' as const,
  };
  const contains = (from: string, to: string) => ({
    id: edgeId('contains', from, to),
    kind: 'contains' as const,
    from,
    to,
    resolutionStatus: 'resolved' as const,
  });
  const nodes = [
    repository,
    fileA,
    fileB,
    moduleA,
    moduleB,
    caller,
    callee,
    sharedA,
    sharedB,
  ];
  return {
    schemaVersion: 1,
    completeness,
    repository: { root: '.', name: 'repository' },
    nodes,
    edges: [
      contains(repository.id, fileA.id),
      contains(repository.id, fileB.id),
      contains(fileA.id, moduleA.id),
      contains(fileB.id, moduleB.id),
      contains(moduleA.id, caller.id),
      contains(moduleB.id, callee.id),
      contains(moduleA.id, sharedA.id),
      contains(moduleB.id, sharedB.id),
      {
        id: edgeId('imports', moduleA.id, moduleB.id),
        kind: 'imports',
        from: moduleA.id,
        to: moduleB.id,
        resolutionStatus: 'resolved',
      },
      {
        id: edgeId('calls', caller.id, callee.id),
        kind: 'calls',
        from: caller.id,
        to: callee.id,
        resolutionStatus: 'resolved',
      },
    ],
    diagnostics: [],
  };
}

function response<T extends QueryResponseV1['operation']>(
  value: QueryResponseV1 | QueryErrorV1,
  operation: T,
): QueryResponseV1 & { readonly operation: T } {
  if (!('operation' in value) || value.operation !== operation)
    throw new Error(`Expected ${operation} response.`);
  return value as QueryResponseV1 & { readonly operation: T };
}

function queryError(value: QueryResponseV1 | QueryErrorV1): QueryErrorV1 {
  if (!('code' in value)) throw new Error('Expected query error.');
  return value as QueryErrorV1;
}

test('search and file/call relations are deterministic and directional', () => {
  const snapshot = fixture();
  const service = createGraphQueryService(snapshot);
  const symbols = response(
    service.searchSymbols({ operation: 'searchSymbols', query: 'call' }),
    'searchSymbols',
  );
  assert.deepEqual(
    symbols.page.items.map((item) => item.qualifiedName),
    ['caller', 'callee'],
  );

  const files = response(
    service.listFileDependencies({
      operation: 'listFileDependencies',
      fileId: fileId('src/a.ts'),
    }),
    'listFileDependencies',
  );
  assert.deepEqual(
    files.page.items.map((item) => item.path),
    ['src/b.ts'],
  );
  const inverse = response(
    service.listFileDependencies({
      operation: 'listFileDependencies',
      fileId: fileId('src/b.ts'),
    }),
    'listFileDependencies',
  );
  assert.deepEqual(inverse.page.items, []);

  const callees = response(
    service.listCallees({
      operation: 'listCallees',
      function: { name: 'caller' },
    }),
    'listCallees',
  );
  assert.deepEqual(
    callees.page.items.map((item) => item.qualifiedName),
    ['callee'],
  );
  const callers = response(
    service.listCallers({
      operation: 'listCallers',
      function: { name: 'callee' },
    }),
    'listCallers',
  );
  assert.deepEqual(
    callers.page.items.map((item) => item.qualifiedName),
    ['caller'],
  );
});

test('ambiguity and cursor pagination remain bounded and typed', () => {
  const service = createGraphQueryService(fixture());
  const ambiguous = queryError(
    service.getSymbol({
      operation: 'getSymbol',
      selector: { kind: 'function', qualifiedName: 'shared' },
      limit: 1,
    }),
  );
  assert.equal(ambiguous.code, 'ambiguous');
  assert.equal(ambiguous.totalCandidates, 2);
  assert.deepEqual(
    ambiguous.candidates?.items.map((item) => item.path),
    ['src/a.ts'],
  );
  assert.equal(ambiguous.candidates?.truncated, true);

  const first = response(
    service.searchSymbols({ operation: 'searchSymbols', query: 'a', limit: 1 }),
    'searchSymbols',
  );
  assert.equal(first.page.items.length, 1);
  assert.equal(first.page.truncated, true);
  assert.ok(first.page.continuation);
  const second = response(
    service.searchSymbols({
      operation: 'searchSymbols',
      query: 'a',
      limit: 1,
      cursor: first.page.continuation,
    }),
    'searchSymbols',
  );
  assert.equal(second.page.items.length, 1);
  assert.notEqual(second.page.items[0]?.id, first.page.items[0]?.id);
});

test('partial snapshots require explicit opt-in and invalid requests do not leak data', () => {
  const service = createGraphQueryService(fixture('partial'));
  const rejected = queryError(
    service.searchSymbols({ operation: 'searchSymbols', query: 'caller' }),
  );
  assert.equal(rejected.code, 'partial_not_allowed');
  const allowed = response(
    service.searchSymbols({
      operation: 'searchSymbols',
      query: 'caller',
      allowPartial: true,
    }),
    'searchSymbols',
  );
  assert.equal(allowed.page.completeness, 'partial');
  const invalid = queryError(
    service.searchSymbols({ operation: 'searchSymbols', query: '   ' }),
  );
  assert.equal(invalid.code, 'invalid_request');
  assert.equal(invalid.message, 'The query request is invalid.');
});

test('query indexes and returned summaries are isolated from caller mutation', () => {
  const snapshot = fixture();
  const service = createGraphQueryService(snapshot);
  const first = response(
    service.searchSymbols({ operation: 'searchSymbols', query: 'caller' }),
    'searchSymbols',
  );
  const firstItem = first.page.items[0]!;
  (firstItem as { name: string }).name = 'changed';
  const sourceNode = snapshot.nodes.find((node) => node.id === firstItem.id)!;
  (sourceNode as { name: string }).name = 'changed';

  const repeated = response(
    service.searchSymbols({ operation: 'searchSymbols', query: 'caller' }),
    'searchSymbols',
  );
  assert.equal(repeated.page.items[0]?.name, 'caller');
});
