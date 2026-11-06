import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  createGraphQueryService,
  decode,
  edgeId,
  edgeIdV2,
  encode,
  fileId,
  fileIdV2,
  MAX_RELATION_EVIDENCE_PER_COUNTERPART,
  nodeId,
  nodeIdV2,
  repositoryId,
  repositoryIdV2,
  type QueryErrorV1,
  type QueryResponseV1,
  type SnapshotV1,
  type SnapshotV2,
  type SnapshotV3,
  type NodeV1,
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

function node(
  snapshot: SnapshotV1,
  kind: NodeV1['kind'],
  name: string,
): NodeV1 & { readonly path: string; readonly qualifiedName: string } {
  const value = snapshot.nodes.find(
    (item) => item.kind === kind && 'name' in item && item.name === name,
  );
  if (value === undefined) throw new Error(`Missing ${kind} ${name}.`);
  return value as NodeV1 & {
    readonly path: string;
    readonly qualifiedName: string;
  };
}

function cursorJson(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

function cursorFromJson(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url');
}

function emptyValidatedSnapshot(): SnapshotV1 {
  return decode(
    encode({
      schemaVersion: 1,
      completeness: 'complete',
      repository: { root: '.', name: 'empty' },
      nodes: [
        {
          id: repositoryId(),
          kind: 'repository',
          root: '.',
          name: 'empty',
        },
      ],
      edges: [],
      diagnostics: [],
    }),
  ) as SnapshotV1;
}

function withUnicodeSymbol(snapshot: SnapshotV1): SnapshotV1 {
  const repository = node(snapshot, 'repository', 'repository');
  const file = node(snapshot, 'file', 'a.ts');
  const module = node(snapshot, 'module', 'a');
  const name = 'café';
  const accent = {
    id: nodeId(
      'function',
      file.path,
      `${repository.id}/${file.id}/${module.id}#scope=module:${module.qualifiedName}`,
      name,
      'none',
    ),
    kind: 'function' as const,
    name,
    path: file.path,
    qualifiedName: name,
    memberRole: 'none' as const,
  };
  return {
    ...snapshot,
    nodes: [...snapshot.nodes, accent],
    edges: [
      ...snapshot.edges,
      {
        id: edgeId('contains', module.id, accent.id),
        kind: 'contains' as const,
        from: module.id,
        to: accent.id,
        resolutionStatus: 'resolved' as const,
      },
    ],
  };
}

function withRepeatedRelationsAndSelfCall(snapshot: SnapshotV1): SnapshotV1 {
  const moduleA = node(snapshot, 'module', 'a');
  const moduleB = node(snapshot, 'module', 'b');
  const caller = node(snapshot, 'function', 'caller');
  return {
    ...snapshot,
    edges: [
      ...snapshot.edges,
      {
        id: edgeId('exports', moduleA.id, moduleB.id),
        kind: 'exports',
        from: moduleA.id,
        to: moduleB.id,
        resolutionStatus: 'resolved',
      },
      {
        id: edgeId('calls', caller.id, caller.id),
        kind: 'calls',
        from: caller.id,
        to: caller.id,
        resolutionStatus: 'resolved',
      },
    ],
  };
}

function withLargeCallRelation(snapshot: SnapshotV1): SnapshotV1 {
  const repository = node(snapshot, 'repository', 'repository');
  const file = node(snapshot, 'file', 'b.ts');
  const module = node(snapshot, 'module', 'b');
  const caller = node(snapshot, 'function', 'caller');
  const functions = Array.from({ length: 100 }, (_, index) => {
    const name = `callee-${String(index).padStart(3, '0')}`;
    return {
      id: nodeId(
        'function',
        file.path,
        `${repository.id}/${file.id}/${module.id}#scope=module:${module.qualifiedName}`,
        name,
        'none',
      ),
      kind: 'function' as const,
      name,
      path: file.path,
      qualifiedName: name,
      memberRole: 'none' as const,
    };
  });
  return {
    ...snapshot,
    nodes: [...snapshot.nodes, ...functions],
    edges: [
      ...snapshot.edges,
      ...functions.flatMap((callee) => [
        {
          id: edgeId('contains', module.id, callee.id),
          kind: 'contains' as const,
          from: module.id,
          to: callee.id,
          resolutionStatus: 'resolved' as const,
        },
        {
          id: edgeId('calls', caller.id, callee.id),
          kind: 'calls' as const,
          from: caller.id,
          to: callee.id,
          resolutionStatus: 'resolved' as const,
        },
      ]),
    ],
  };
}

function withContainmentCycle(snapshot: SnapshotV1): SnapshotV1 {
  const module = node(snapshot, 'module', 'a');
  return {
    ...snapshot,
    edges: [
      ...snapshot.edges,
      {
        id: edgeId('contains', module.id, module.id),
        kind: 'contains' as const,
        from: module.id,
        to: module.id,
        resolutionStatus: 'resolved' as const,
      },
    ],
  };
}

function withDependencyCycle(snapshot: SnapshotV1): SnapshotV1 {
  const moduleA = node(snapshot, 'module', 'a');
  const moduleB = node(snapshot, 'module', 'b');
  return {
    ...snapshot,
    edges: [
      ...snapshot.edges,
      {
        id: edgeId('imports', moduleB.id, moduleA.id),
        kind: 'imports' as const,
        from: moduleB.id,
        to: moduleA.id,
        resolutionStatus: 'resolved' as const,
      },
    ],
  };
}

function reordered(snapshot: SnapshotV1): SnapshotV1 {
  return {
    ...snapshot,
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges].reverse(),
  };
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

test('searchSymbols documents substring matches as candidates, not exact selection', () => {
  const snapshot = fixture();
  const caller = node(snapshot, 'function', 'caller');
  const module = node(snapshot, 'module', 'a');
  const substringCandidate = {
    ...caller,
    id: nodeId(
      'function',
      caller.path,
      `${snapshot.nodes[0]!.id}/${fileId(caller.path)}/${module.id}#scope=module:${module.qualifiedName}`,
      'user-caller',
      'none',
    ),
    name: 'user-caller',
    qualifiedName: 'user-caller',
  };
  const extended = {
    ...snapshot,
    nodes: [...snapshot.nodes, substringCandidate],
    edges: [
      ...snapshot.edges,
      {
        id: edgeId('contains', module.id, substringCandidate.id),
        kind: 'contains' as const,
        from: module.id,
        to: substringCandidate.id,
        resolutionStatus: 'resolved' as const,
      },
    ],
  } satisfies SnapshotV1;
  const searched = createGraphQueryService(extended).searchSymbols({
    operation: 'searchSymbols',
    query: 'caller',
    kind: 'function',
  });
  assert.ok('operation' in searched, JSON.stringify(searched));
  const symbols = response(searched, 'searchSymbols');
  assert.deepEqual(
    symbols.page.items.map((item) => item.name),
    ['caller', 'user-caller'],
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
  assert.ok(ambiguous.candidates?.continuation);
  const ambiguousSecond = queryError(
    service.getSymbol({
      operation: 'getSymbol',
      selector: { kind: 'function', qualifiedName: 'shared' },
      limit: 1,
      cursor: ambiguous.candidates?.continuation,
    }),
  );
  assert.equal(ambiguousSecond.code, 'ambiguous');
  assert.deepEqual(
    ambiguousSecond.candidates?.items.map((item) => item.path),
    ['src/b.ts'],
  );
  assert.equal(ambiguousSecond.candidates?.truncated, false);
  assert.equal(ambiguousSecond.candidates?.continuation, undefined);
  assert.deepEqual(
    queryError(
      service.getSymbol({
        operation: 'getSymbol',
        selector: { kind: 'function', qualifiedName: 'shared' },
        limit: 1,
        cursor: ambiguous.candidates?.continuation,
      }),
    ),
    ambiguousSecond,
  );

  const functionAmbiguous = queryError(
    service.listCallers({
      operation: 'listCallers',
      function: { name: 'shared' },
      limit: 1,
    }),
  );
  assert.equal(functionAmbiguous.code, 'ambiguous');
  assert.equal(functionAmbiguous.totalCandidates, 2);
  assert.ok(functionAmbiguous.candidates?.continuation);
  const functionAmbiguousSecond = queryError(
    service.listCallers({
      operation: 'listCallers',
      function: { name: 'shared' },
      limit: 1,
      cursor: functionAmbiguous.candidates?.continuation,
    }),
  );
  assert.equal(functionAmbiguousSecond.code, 'ambiguous');
  assert.deepEqual(
    functionAmbiguousSecond.candidates?.items.map((item) => item.path),
    ['src/b.ts'],
  );
  assert.equal(functionAmbiguousSecond.candidates?.truncated, false);

  const childFirst = response(
    service.getSymbol({
      operation: 'getSymbol',
      selector: { kind: 'module', name: 'a' },
      limit: 1,
    }),
    'getSymbol',
  );
  assert.ok(childFirst.children.continuation);
  const childSecond = response(
    service.getSymbol({
      operation: 'getSymbol',
      selector: { kind: 'module', name: 'a' },
      limit: 1,
      cursor: childFirst.children.continuation,
    }),
    'getSymbol',
  );
  assert.equal(childSecond.children.truncated, false);
  assert.equal(childSecond.children.continuation, undefined);

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
  assert.equal(second.page.truncated, true);
  const terminalSearch = response(
    service.searchSymbols({
      operation: 'searchSymbols',
      query: 'shared',
      limit: 1,
    }),
    'searchSymbols',
  );
  assert.ok(terminalSearch.page.continuation);
  const terminalSearchSecond = response(
    service.searchSymbols({
      operation: 'searchSymbols',
      query: 'shared',
      limit: 1,
      cursor: terminalSearch.page.continuation,
    }),
    'searchSymbols',
  );
  assert.equal(terminalSearchSecond.page.truncated, false);
  assert.equal(terminalSearchSecond.page.continuation, undefined);
  assert.deepEqual(
    response(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'shared',
        limit: 1,
        cursor: terminalSearch.page.continuation,
      }),
      'searchSymbols',
    ),
    terminalSearchSecond,
  );
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

test('query acceptance covers empty, missing, wrong-type, NFC, and exact filters', () => {
  const snapshot = withUnicodeSymbol(fixture());
  const service = createGraphQueryService(snapshot);
  const moduleA = node(snapshot, 'module', 'a');

  const nfc = response(
    service.searchSymbols({
      operation: 'searchSymbols',
      query: 'cafe\u0301',
      kind: 'function',
      path: 'src/a.ts',
      containerId: moduleA.id,
    }),
    'searchSymbols',
  );
  assert.deepEqual(
    nfc.page.items.map((item) => item.qualifiedName),
    ['café'],
  );
  assert.deepEqual(
    response(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'CAFÉ',
        kind: 'function',
        path: 'src/a.ts',
        containerId: moduleA.id,
      }),
      'searchSymbols',
    ).page.items,
    [],
  );
  assert.deepEqual(
    response(
      service.listFileDependencies({
        operation: 'listFileDependencies',
        fileId: fileId('src/b.ts'),
      }),
      'listFileDependencies',
    ).page,
    {
      schemaVersion: 1,
      completeness: 'complete',
      items: [],
      total: 0,
      truncated: false,
    },
  );

  assert.equal(
    queryError(
      service.getSymbol({
        operation: 'getSymbol',
        selector: { name: 'missing' },
      }),
    ).code,
    'not_found',
  );
  assert.equal(
    queryError(
      service.getSymbol({
        operation: 'getSymbol',
        nodeId: fileId('src/a.ts'),
      }),
    ).code,
    'entity_type_mismatch',
  );
  assert.equal(
    queryError(
      service.listFileDependencies({
        operation: 'listFileDependencies',
        fileId: fileId('src/missing.ts'),
      }),
    ).code,
    'not_found',
  );
  assert.equal(
    queryError(
      service.listCallers({
        operation: 'listCallers',
        function: { name: 'missing' },
      }),
    ).code,
    'not_found',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'x',
        limit: 0,
      }),
    ).code,
    'limit_exceeded',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'x',
        limit: 101,
      }),
    ).code,
    'limit_exceeded',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'x',
        limit: 1.5,
      }),
    ).code,
    'invalid_request',
  );
});

test('validated empty snapshots return deterministic empty results', () => {
  const service = createGraphQueryService(emptyValidatedSnapshot());
  const search = response(
    service.searchSymbols({ operation: 'searchSymbols', query: 'anything' }),
    'searchSymbols',
  );

  assert.deepEqual(search.page, {
    schemaVersion: 1,
    completeness: 'complete',
    items: [],
    total: 0,
    truncated: false,
  });
  assert.equal(
    queryError(
      service.listFileDependencies({
        operation: 'listFileDependencies',
        fileId: fileId('src/missing.ts'),
      }),
    ).code,
    'not_found',
  );
});

test('separate-file dependency cycles remain deterministic and one-hop', () => {
  const snapshot = withDependencyCycle(fixture());
  const service = createGraphQueryService(snapshot);
  const reorderedService = createGraphQueryService(reordered(snapshot));

  for (const [file, dependency] of [
    ['src/a.ts', 'src/b.ts'],
    ['src/b.ts', 'src/a.ts'],
  ] as const) {
    const request = {
      operation: 'listFileDependencies' as const,
      fileId: fileId(file),
    };
    const result = response(
      service.listFileDependencies(request),
      request.operation,
    );
    assert.deepEqual(
      result.page.items.map((item) => item.path),
      [dependency],
    );
    assert.equal(result.page.total, 1);
    assert.equal(result.page.truncated, false);
    assert.deepEqual(
      response(
        reorderedService.listFileDependencies(request),
        request.operation,
      ),
      result,
    );
    assert.deepEqual(
      response(service.listFileDependencies(request), request.operation),
      result,
    );
  }

  for (const [file, dependent] of [
    ['src/a.ts', 'src/b.ts'],
    ['src/b.ts', 'src/a.ts'],
  ] as const) {
    const request = {
      operation: 'listFileDependents' as const,
      fileId: fileId(file),
    };
    const result = response(
      service.listFileDependents(request),
      request.operation,
    );
    assert.deepEqual(
      result.page.items.map((item) => item.path),
      [dependent],
    );
    assert.equal(result.page.total, 1);
    assert.equal(result.page.truncated, false);
    assert.deepEqual(
      response(reorderedService.listFileDependents(request), request.operation),
      result,
    );
  }
});

test('cursor JSON is canonical, bounded, filter-bound, and snapshot-bound', () => {
  const snapshot = fixture();
  const service = createGraphQueryService(snapshot);
  const first = response(
    service.searchSymbols({ operation: 'searchSymbols', query: 'a', limit: 1 }),
    'searchSymbols',
  );
  const cursor = first.page.continuation!;
  assert.equal(
    cursor,
    'eyJzY2hlbWFWZXJzaW9uIjoxLCJzbmFwc2hvdERpZ2VzdCI6IjBiMWZmNjhlMGI5ZTc3ZDA4Njk1OWM2NDgyOWE5ZjZkMjg5NGQ1N2NhYzJhMjNkZWQ4MjBiMzYxMWIxN2NmZjUiLCJvcGVyYXRpb24iOiJzZWFyY2hTeW1ib2xzIiwiZmlsdGVyRmluZ2VycHJpbnQiOiI4NGIzODlmOTIzYTMwMWIxYTdjOWNmNDhkMTU4NTE5ZDNkZDMxNTc3YzcyOThlNWM3Yjk1OGE2MzBiZjVkY2E5IiwibGFzdFNvcnRLZXkiOltbMCwic3JjL2EudHMiXSwiYSIsIm1vZHVsZSIsIm46ZjdkNDU0Y2ZjMDY3ZGE2ZDMzMGZjZTAyZjVkNTY0YjU2NzQ3NTg2ODdkYWQ1YzgyY2IwZjMzODIzMzNiYTYzNCJdfQ',
  );
  const decoded = cursorJson(cursor);
  assert.equal(cursorFromJson(decoded), cursor);
  assert.deepEqual(Object.keys(JSON.parse(decoded) as object), [
    'schemaVersion',
    'snapshotDigest',
    'operation',
    'filterFingerprint',
    'lastSortKey',
  ]);
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
        cursor: cursorFromJson(` ${decoded}`),
      }),
    ).code,
    'invalid_request',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
        cursor: cursorFromJson(
          decoded.replace(
            '"operation":"searchSymbols"',
            '"operation":"search\\u0053ymbols"',
          ),
        ),
      }),
    ).code,
    'invalid_request',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
        cursor: cursorFromJson(
          decoded.replace(
            '{"schemaVersion":1,',
            '{"schemaVersion":1,"schemaVersion":1,',
          ),
        ),
      }),
    ).code,
    'invalid_request',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
        cursor: cursorFromJson(decoded.replace('"src/a.ts"', '"\\ud800"')),
      }),
    ).code,
    'invalid_request',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
        cursor: cursorFromJson(
          decoded.replace(
            '"schemaVersion":1,"snapshotDigest"',
            '"snapshotDigest"',
          ),
        ),
      }),
    ).code,
    'invalid_request',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
        cursor: `${'A'.repeat(4097)}`,
      }),
    ).code,
    'invalid_request',
  );
  assert.equal(
    queryError(
      service.searchSymbols({
        operation: 'searchSymbols',
        query: 'different',
        cursor,
      }),
    ).code,
    'invalid_request',
  );
  const replacement = createGraphQueryService(withUnicodeSymbol(snapshot));
  assert.equal(
    queryError(
      replacement.searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
        cursor,
      }),
    ).code,
    'invalid_request',
  );
});

test('query ordering is independent of input order and relation duplicates', () => {
  const snapshot = withRepeatedRelationsAndSelfCall(fixture());
  const reorderedService = createGraphQueryService(reordered(snapshot));
  const service = createGraphQueryService(snapshot);
  const request = {
    operation: 'searchSymbols' as const,
    query: 'a',
    limit: 1,
  };
  const first = response(service.searchSymbols(request), 'searchSymbols');
  const reorderedFirst = response(
    reorderedService.searchSymbols(request),
    'searchSymbols',
  );
  assert.deepEqual(reorderedFirst, first);
  assert.deepEqual(
    response(
      service.listFileDependencies({
        operation: 'listFileDependencies',
        fileId: fileId('src/a.ts'),
      }),
      'listFileDependencies',
    ).page.items.map((item) => item.path),
    ['src/b.ts'],
  );
  assert.deepEqual(
    response(
      service.listCallees({
        operation: 'listCallees',
        function: { name: 'caller' },
      }),
      'listCallees',
    ).page.items.map((item) => item.qualifiedName),
    ['callee', 'caller'],
  );
  assert.equal(
    queryError(
      createGraphQueryService(withContainmentCycle(fixture())).searchSymbols({
        operation: 'searchSymbols',
        query: 'a',
      }),
    ).code,
    'invalid_snapshot',
  );
});

test('large counterpart relations page through the terminal result repeatedly', () => {
  const service = createGraphQueryService(withLargeCallRelation(fixture()));
  const first = response(
    service.listCallees({
      operation: 'listCallees',
      function: { name: 'caller' },
      limit: 100,
    }),
    'listCallees',
  );
  assert.equal(first.page.total, 101);
  assert.equal(first.page.items.length, 100);
  assert.equal(first.page.truncated, true);
  assert.ok(first.page.continuation);
  const terminal = response(
    service.listCallees({
      operation: 'listCallees',
      function: { name: 'caller' },
      limit: 100,
      cursor: first.page.continuation,
    }),
    'listCallees',
  );
  assert.equal(terminal.page.total, 101);
  assert.equal(terminal.page.items.length, 1);
  assert.equal(terminal.page.truncated, false);
  assert.equal(terminal.page.continuation, undefined);
  assert.deepEqual(
    response(
      service.listCallees({
        operation: 'listCallees',
        function: { name: 'caller' },
        limit: 100,
        cursor: first.page.continuation,
      }),
      'listCallees',
    ),
    terminal,
  );
});

test('schema-v2 queries expose versioned pages and container nodes', () => {
  const repository = {
    id: repositoryIdV2(),
    kind: 'repository' as const,
    root: '.' as const,
    name: 'repository',
  };
  const project = {
    id: nodeIdV2(
      'project',
      'App.csproj',
      `${repository.id}#scope=root`,
      'App',
      'App',
      'none',
    ),
    kind: 'project' as const,
    name: 'App',
    path: 'App.csproj',
    qualifiedName: 'App',
    memberRole: 'none' as const,
  };
  const file = {
    id: fileIdV2('Program.cs'),
    kind: 'file' as const,
    name: 'Program.cs',
    path: 'Program.cs',
  };
  const module = {
    id: nodeIdV2(
      'module',
      file.path,
      `${file.id}#scope=root`,
      file.path,
      file.path,
      'none',
    ),
    kind: 'module' as const,
    name: file.path,
    path: file.path,
    qualifiedName: file.path,
    memberRole: 'none' as const,
  };
  const namespace = {
    id: nodeIdV2(
      'namespace',
      file.path,
      `${module.id}#scope=module:${module.qualifiedName}`,
      'App',
      'App',
      'none',
    ),
    kind: 'namespace' as const,
    name: 'App',
    path: file.path,
    qualifiedName: 'App',
    memberRole: 'none' as const,
  };
  const contains = (from: { id: string }, to: { id: string }) => ({
    id: edgeIdV2('contains', from.id, to.id),
    kind: 'contains' as const,
    from: from.id,
    to: to.id,
    resolutionStatus: 'resolved' as const,
  });
  const snapshot: SnapshotV2 = {
    schemaVersion: 2,
    completeness: 'complete',
    repository: { root: '.', name: 'repository' },
    nodes: [repository, project, file, module, namespace],
    edges: [
      contains(repository, project),
      contains(project, file),
      contains(file, module),
      contains(module, namespace),
    ],
    diagnostics: [],
  };
  const service = createGraphQueryService(snapshot);
  const search = service.searchSymbols({
    operation: 'searchSymbols',
    query: 'App',
    kind: 'project',
  });
  assert.ok(!('code' in search) && search.operation === 'searchSymbols');
  if ('code' in search || search.operation !== 'searchSymbols')
    throw new Error('Expected a search response.');
  assert.equal(search.page.schemaVersion, 2);
  assert.equal(search.page.items[0]?.kind, 'project');
  const details = service.getSymbol({
    operation: 'getSymbol',
    nodeId: project.id,
  });
  assert.ok(!('code' in details) && details.operation === 'getSymbol');
  if ('code' in details || details.operation !== 'getSymbol')
    throw new Error('Expected a symbol response.');
  assert.equal(details.schemaVersion, 2);
  assert.equal(details.children.schemaVersion, 2);
  assert.deepEqual(
    details.children.items.map((item) => item.kind),
    ['file'],
  );
});

test('schema-v3 queries return pack metadata and relationship evidence', () => {
  const repository = {
    id: repositoryIdV2(),
    kind: 'repository' as const,
    root: '.' as const,
    name: 'repository',
  };
  const project = {
    id: nodeIdV2(
      'project',
      'App.csproj',
      `${repository.id}#scope=root`,
      'App',
      'App',
      'none',
    ),
    kind: 'project' as const,
    name: 'App',
    path: 'App.csproj',
    qualifiedName: 'App',
    memberRole: 'none' as const,
  };
  const file = (path: string) => ({
    id: fileIdV2(path),
    kind: 'file' as const,
    name: path.split('/').at(-1)!,
    path,
  });
  const a = file('src/a.ts');
  const b = file('src/b.ts');
  const module = (source: typeof a) => ({
    id: nodeIdV2(
      'module',
      source.path,
      `${source.id}#scope=root`,
      source.path,
      source.path,
      'none',
    ),
    kind: 'module' as const,
    name: source.path,
    path: source.path,
    qualifiedName: source.path,
    memberRole: 'none' as const,
  });
  const moduleA = module(a);
  const moduleB = module(b);
  const functionNode = (
    source: typeof a,
    parent: typeof moduleA,
    name: string,
  ) => ({
    id: nodeIdV2(
      'function',
      source.path,
      `${parent.id}#scope=module:${parent.qualifiedName}`,
      name,
      name,
      'none',
    ),
    kind: 'function' as const,
    name,
    path: source.path,
    qualifiedName: name,
    memberRole: 'none' as const,
  });
  const caller = functionNode(a, moduleA, 'caller');
  const callee = functionNode(b, moduleB, 'callee');
  const contains = (
    from: { readonly id: string },
    to: { readonly id: string },
  ) => ({
    id: edgeIdV2('contains', from.id, to.id),
    kind: 'contains' as const,
    from: from.id,
    to: to.id,
    resolutionStatus: 'resolved' as const,
  });
  const attributed = <T extends { readonly kind: string }>(node: T) =>
    node.kind === 'repository'
      ? node
      : { ...node, packId: 'typescript-pack', language: 'typescript' };
  const snapshot: SnapshotV3 = {
    schemaVersion: 3,
    completeness: 'complete',
    repository: { root: '.', name: 'repository' },
    metadata: {
      verification: 'unverified',
      packs: [
        {
          id: 'typescript-pack',
          language: 'typescript',
          version: '1.0.0',
          capabilities: ['source-analysis'],
        },
      ],
    },
    nodes: [repository, project, a, b, moduleA, moduleB, caller, callee].map(
      attributed,
    ) as SnapshotV3['nodes'],
    edges: [
      contains(repository, project),
      contains(project, a),
      contains(project, b),
      contains(a, moduleA),
      contains(b, moduleB),
      contains(moduleA, caller),
      contains(moduleB, callee),
      {
        id: edgeIdV2('imports', moduleA.id, moduleB.id),
        kind: 'imports' as const,
        from: moduleA.id,
        to: moduleB.id,
        resolutionStatus: 'resolved' as const,
        packId: 'typescript-pack',
        evidence: 'syntactic' as const,
      },
      {
        id: edgeIdV2('calls', caller.id, callee.id),
        kind: 'calls' as const,
        from: caller.id,
        to: callee.id,
        resolutionStatus: 'resolved' as const,
        packId: 'typescript-pack',
        evidence: 'semantic' as const,
      },
    ],
    diagnostics: [],
  };
  const service = createGraphQueryService(snapshot);
  const projectDetails = service.getSymbol({
    operation: 'getSymbol',
    nodeId: project.id,
  });
  assert.ok(!('code' in projectDetails), JSON.stringify(projectDetails));
  if ('code' in projectDetails || projectDetails.operation !== 'getSymbol')
    throw new Error('Expected a project response.');
  assert.deepEqual(
    projectDetails.children.items.map((item) => item.kind),
    ['file', 'file'],
  );
  assert.equal(projectDetails.metadata.verification, 'unverified');
  const callers = service.listCallers({
    operation: 'listCallers',
    function: { name: 'callee', path: b.path },
  });
  assert.ok(!('code' in callers));
  if ('code' in callers || callers.operation !== 'listCallers')
    throw new Error('Expected a caller response.');
  assert.equal(callers.page.schemaVersion, 3);
  assert.equal(callers.metadata.packs[0]?.id, 'typescript-pack');
  assert.deepEqual(callers.page.items[0]?.relationships, [
    {
      id: edgeIdV2('calls', caller.id, callee.id),
      kind: 'calls',
      packId: 'typescript-pack',
      evidence: 'semantic',
    },
  ]);
  const dependencies = service.listFileDependencies({
    operation: 'listFileDependencies',
    fileId: a.id,
  });
  assert.ok(!('code' in dependencies));
  if (
    'code' in dependencies ||
    dependencies.operation !== 'listFileDependencies'
  )
    throw new Error('Expected a dependency response.');
  assert.equal(dependencies.page.items[0]?.node.language, 'typescript');
  assert.equal(
    dependencies.page.items[0]?.relationships[0]?.evidence,
    'syntactic',
  );
  assert.equal(dependencies.page.items[0]?.relationshipsTotal, 1);
  assert.equal(dependencies.page.items[0]?.relationshipsTruncated, false);

  const modulePairs = Array.from({ length: 65 }, (_, index) => {
    const source = {
      id: nodeIdV2(
        'module',
        a.path,
        `${a.id}#scope=root`,
        `source-${index}`,
        `source-${index}`,
        'none',
      ),
      kind: 'module' as const,
      name: `source-${index}`,
      path: a.path,
      qualifiedName: `source-${index}`,
      memberRole: 'none' as const,
    };
    const target = {
      id: nodeIdV2(
        'module',
        b.path,
        `${b.id}#scope=root`,
        `target-${index}`,
        `target-${index}`,
        'none',
      ),
      kind: 'module' as const,
      name: `target-${index}`,
      path: b.path,
      qualifiedName: `target-${index}`,
      memberRole: 'none' as const,
    };
    return { source, target };
  });
  const boundedEvidenceSnapshot: SnapshotV3 = {
    ...snapshot,
    nodes: [
      repository,
      project,
      a,
      b,
      ...modulePairs.flatMap(Object.values),
    ].map(attributed) as SnapshotV3['nodes'],
    edges: [
      contains(repository, project),
      contains(project, a),
      contains(project, b),
      ...modulePairs.flatMap(({ source, target }) => [
        contains(a, source),
        contains(b, target),
        {
          id: edgeIdV2('imports', source.id, target.id),
          kind: 'imports' as const,
          from: source.id,
          to: target.id,
          resolutionStatus: 'resolved' as const,
          packId: 'typescript-pack',
          evidence: 'syntactic' as const,
        },
      ]),
    ] as SnapshotV3['edges'],
  };
  const boundedEvidence = createGraphQueryService(
    boundedEvidenceSnapshot,
  ).listFileDependencies({
    operation: 'listFileDependencies',
    fileId: a.id,
  });
  assert.ok(!('code' in boundedEvidence));
  if (
    'code' in boundedEvidence ||
    boundedEvidence.operation !== 'listFileDependencies'
  )
    throw new Error('Expected a bounded relation response.');
  assert.equal(boundedEvidence.page.items[0]?.relationshipsTotal, 65);
  assert.equal(boundedEvidence.page.items[0]?.relationshipsTruncated, true);
  assert.equal(
    boundedEvidence.page.items[0]?.relationships.length,
    MAX_RELATION_EVIDENCE_PER_COUNTERPART,
  );
  assert.deepEqual(
    boundedEvidence.page.items[0]?.relationships.map(({ id }) => id),
    [...(boundedEvidence.page.items[0]?.relationships ?? [])]
      .map(({ id }) => id)
      .sort(),
  );
});
