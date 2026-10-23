import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  compareDiagnostics,
  compareEdges,
  compareEdgesV2,
  compareLocations,
  compareNodes,
  digest,
  edgeId,
  edgeIdV2,
  fileId,
  fileIdV2,
  nodeId,
  nodeIdV2,
  repositoryId,
  repositoryIdV2,
  type DiagnosticV1,
  type EdgeKindV1,
  type EdgeKindV2,
  type EdgeV1,
  type EdgeV2,
  type LocationV1,
  type NodeKind,
  type NodeKindV2,
  type NodeV1,
  type NodeV2,
} from '../graph.js';
import {
  SnapshotError,
  type Snapshot,
  type SnapshotV1,
  type SnapshotV2,
} from './types.js';

export const MAX_BYTES = 64 * 1024 * 1024;
const MAX_STRING = 16 * 1024;
const MAX_NODES = 100_000;
const MAX_EDGES = 200_000;
const MAX_DIAGNOSTICS = 10_000;
const MAX_LOCATIONS_PER_ITEM = 4_096;
const MAX_LOCATION_BYTES_PER_ITEM = 256 * 1024;
const kinds = new Set<NodeKind>([
  'repository',
  'file',
  'module',
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const edgeKinds = new Set<EdgeKindV1>([
  'contains',
  'imports',
  'exports',
  'extends',
  'implements',
  'calls',
]);
const roles = new Set(['none', 'static', 'instance']);
const diagnosticCodes = new Set([
  'unsupported_declaration',
  'duplicate_declaration',
  'declaration.unstable_identity',
  'graph.node_id_collision',
  'relationship_external',
  'relationship_unresolved',
  'relationship_ambiguous',
  'relationship_dynamic',
  'relationship_unsupported',
  'relationship_missing_source',
]);
const reasons = new Set([
  'external-target',
  'unresolved-target',
  'ambiguous-target',
  'dynamic-target',
  'unsupported-relation',
  'missing-source-node',
]);
const messages: Record<string, string> = {
  unsupported_declaration: 'Declaration kind is unsupported in the MVP.',
  duplicate_declaration: 'Duplicate declaration signature was omitted.',
  'declaration.unstable_identity':
    'Declaration identity could not be stabilized.',
  'graph.node_id_collision':
    'Graph node identity collision prevented node emission.',
  relationship_external:
    'Relationship targets an external module or declaration.',
  relationship_unresolved: 'Relationship could not be resolved.',
  relationship_ambiguous: 'Relationship target is ambiguous.',
  relationship_dynamic: 'Relationship is dynamic and was not emitted.',
  relationship_unsupported: 'Relationship kind is unsupported in the MVP.',
  relationship_missing_source:
    'Relationship source is not an eligible local source.',
};

function invalid(detail = 'The snapshot is invalid.'): SnapshotError {
  return new SnapshotError('invalid_snapshot', detail);
}
function fail(condition: unknown, detail?: string): asserts condition {
  if (!condition) throw invalid(detail);
}
function ordinal(a: string, b: string): number {
  return Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));
}
function safeString(value: unknown, label: string): string {
  fail(typeof value === 'string', `Invalid snapshot ${label}.`);
  fail(value.length <= MAX_STRING, `Invalid snapshot ${label}.`);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      fail(next >= 0xdc00 && next <= 0xdfff, `Invalid snapshot ${label}.`);
      i += 1;
    } else
      fail(!(code >= 0xdc00 && code <= 0xdfff), `Invalid snapshot ${label}.`);
  }
  return value.normalize('NFC');
}
function object(value: unknown, label: string): Record<string, unknown> {
  fail(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `Invalid snapshot ${label}.`,
  );
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    fail(allowed.includes(key), `Invalid snapshot ${label}.`);
}
function array(value: unknown, label: string): unknown[] {
  fail(Array.isArray(value), `Invalid snapshot ${label}.`);
  return value;
}
function integer(value: unknown, label: string): number {
  fail(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    `Invalid snapshot ${label}.`,
  );
  return value;
}
function pathValue(value: unknown, label: string, allowDot = false): string {
  const result = safeString(value, label);
  fail(
    result !== '' &&
      !result.includes('\\') &&
      !result.includes('\0') &&
      !result.startsWith('/') &&
      !/^[A-Za-z]:/.test(result),
    `Invalid snapshot ${label}.`,
  );
  if (allowDot) {
    fail(result === '.', `Invalid snapshot ${label}.`);
    return result;
  }
  const parts = result.split('/');
  fail(
    parts.every((part) => part !== '' && part !== '.' && part !== '..'),
    `Invalid snapshot ${label}.`,
  );
  return result;
}
function location(value: unknown): LocationV1 {
  const item = object(value, 'location');
  keys(item, ['path', 'start', 'end'], 'location');
  const start = position(item.start);
  const end = position(item.end);
  const result = { path: pathValue(item.path, 'location path'), start, end };
  fail(
    start.line < end.line ||
      (start.line === end.line && start.column < end.column),
    'Invalid snapshot location.',
  );
  return result;
}
function position(value: unknown): {
  readonly line: number;
  readonly column: number;
} {
  const item = object(value, 'position');
  keys(item, ['line', 'column'], 'position');
  const line = integer(item.line, 'line');
  const column = integer(item.column, 'column');
  fail(line > 0 && column > 0, 'Invalid snapshot position.');
  return { line, column };
}
function locations(
  value: unknown,
  bounded = false,
): readonly LocationV1[] | undefined {
  if (value === undefined) return undefined;
  const raw = array(value, 'locations');
  if (bounded)
    fail(raw.length <= MAX_LOCATIONS_PER_ITEM, 'Invalid snapshot locations.');
  const result = raw.map((item) => location(item));
  if (bounded)
    fail(
      Buffer.byteLength(JSON.stringify(result), 'utf8') <=
        MAX_LOCATION_BYTES_PER_ITEM,
      'Invalid snapshot locations.',
    );
  const sorted = [...result].sort(compareLocations);
  for (let i = 1; i < sorted.length; i += 1)
    fail(
      compareLocations(sorted[i - 1]!, sorted[i]!) !== 0,
      'Invalid snapshot duplicate location.',
    );
  return sorted;
}
function locationsV2(value: unknown): readonly LocationV1[] | undefined {
  return locations(value, true);
}
function id(value: unknown, prefix: 'n' | 'e' | 'd'): string {
  const result = safeString(value, 'id');
  fail(
    new RegExp(`^${prefix}:[0-9a-f]{64}$`).test(result),
    'Invalid snapshot identity.',
  );
  return result;
}
function normalizeNode(value: unknown): NodeV1 {
  const item = object(value, 'node');
  const kind = safeString(item.kind, 'node kind') as NodeKind;
  fail(kinds.has(kind), 'Invalid snapshot node kind.');
  if (kind === 'repository') {
    keys(item, ['id', 'kind', 'root', 'name'], 'repository node');
    const result = {
      id: id(item.id, 'n'),
      kind: 'repository' as const,
      root: pathValue(item.root, 'repository root', true) as '.',
      name: safeString(item.name, 'repository name'),
    };
    fail(
      result.root === '.' && result.id === repositoryId() && result.name !== '',
      'Invalid snapshot repository node.',
    );
    return result;
  }
  if (kind === 'file') {
    keys(item, ['id', 'kind', 'name', 'path', 'locations'], 'file node');
    const path = pathValue(item.path, 'file path');
    const normalizedLocations = locations(item.locations);
    const result = {
      id: id(item.id, 'n'),
      kind: 'file' as const,
      name: safeString(item.name, 'file name'),
      path,
      ...(normalizedLocations === undefined
        ? {}
        : { locations: normalizedLocations }),
    };
    fail(result.id === fileId(path), 'Invalid snapshot file identity.');
    return result;
  }
  keys(
    item,
    ['id', 'kind', 'name', 'path', 'qualifiedName', 'memberRole', 'locations'],
    'symbol node',
  );
  const path = pathValue(item.path, 'node path');
  const role = safeString(item.memberRole, 'member role');
  fail(roles.has(role), 'Invalid snapshot member role.');
  const normalizedLocations = locations(item.locations);
  return {
    id: id(item.id, 'n'),
    kind: kind as Exclude<NodeKind, 'repository' | 'file'>,
    name: safeString(item.name, 'node name'),
    path,
    qualifiedName: safeString(item.qualifiedName, 'qualified name'),
    memberRole: role as 'none' | 'static' | 'instance',
    ...(normalizedLocations === undefined
      ? {}
      : { locations: normalizedLocations }),
  };
}
function normalizeEdge(value: unknown): EdgeV1 {
  const item = object(value, 'edge');
  keys(
    item,
    ['id', 'kind', 'from', 'to', 'resolutionStatus', 'locations'],
    'edge',
  );
  const kind = safeString(item.kind, 'edge kind') as EdgeKindV1;
  fail(
    edgeKinds.has(kind) && item.resolutionStatus === 'resolved',
    'Invalid snapshot edge.',
  );
  const from = id(item.from, 'n');
  const to = id(item.to, 'n');
  const normalizedLocations = locations(item.locations);
  const result = {
    id: id(item.id, 'e'),
    kind,
    from,
    to,
    resolutionStatus: 'resolved' as const,
    ...(normalizedLocations === undefined
      ? {}
      : { locations: normalizedLocations }),
  };
  fail(result.id === edgeId(kind, from, to), 'Invalid snapshot edge identity.');
  return result;
}
function normalizeDiagnostic(value: unknown): DiagnosticV1 {
  const item = object(value, 'diagnostic');
  keys(
    item,
    [
      'id',
      'code',
      'severity',
      'message',
      'relationKind',
      'reason',
      'path',
      'location',
      'relatedNodeIds',
    ],
    'diagnostic',
  );
  const code = safeString(item.code, 'diagnostic code');
  fail(
    diagnosticCodes.has(code) &&
      (item.severity === 'warning' || item.severity === 'error'),
    'Invalid snapshot diagnostic.',
  );
  fail(item.message === messages[code], 'Invalid snapshot diagnostic message.');
  if (item.relationKind !== undefined)
    fail(
      edgeKinds.has(
        safeString(item.relationKind, 'relation kind') as EdgeKindV1,
      ),
      'Invalid snapshot diagnostic relation.',
    );
  if (item.reason !== undefined)
    fail(
      reasons.has(safeString(item.reason, 'diagnostic reason')),
      'Invalid snapshot diagnostic reason.',
    );
  const related =
    item.relatedNodeIds === undefined
      ? undefined
      : [
          ...new Set(
            array(item.relatedNodeIds, 'related node ids').map((v) =>
              id(v, 'n'),
            ),
          ),
        ];
  if (related) {
    fail(related.length > 0, 'Invalid snapshot diagnostic related ids.');
    related.sort(ordinal);
  }
  const normalizedPath =
    item.path === undefined
      ? undefined
      : pathValue(item.path, 'diagnostic path');
  const normalizedLocation =
    item.location === undefined ? undefined : location(item.location);
  const result: DiagnosticV1 = {
    id: id(item.id, 'd'),
    code: code as DiagnosticV1['code'],
    severity: item.severity as 'warning' | 'error',
    message: item.message as string,
    ...(item.relationKind === undefined
      ? {}
      : { relationKind: item.relationKind as EdgeKindV1 }),
    ...(item.reason === undefined
      ? {}
      : { reason: item.reason as NonNullable<DiagnosticV1['reason']> }),
    ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
    ...(normalizedLocation === undefined
      ? {}
      : { location: normalizedLocation }),
    ...(related === undefined ? {} : { relatedNodeIds: related }),
  };
  return result;
}
function diagnosticWithId(item: DiagnosticV1): string {
  const locationKey =
    item.location === undefined
      ? undefined
      : `${item.location.path}#${item.location.start.line}:${item.location.start.column}-${item.location.end.line}:${item.location.end.column}`;
  const pathField = item.path === undefined ? 'absent' : `present:${item.path}`;
  const locationField =
    locationKey === undefined ? 'absent' : `present:${locationKey}`;
  const related =
    item.relatedNodeIds === undefined
      ? 'absent'
      : JSON.stringify([...item.relatedNodeIds].sort(ordinal));
  const occurrence = JSON.stringify([
    pathField,
    locationField,
    item.relationKind === undefined ? 'absent' : `present:${item.relationKind}`,
    item.reason === undefined ? 'absent' : `present:${item.reason}`,
    related,
  ]);
  return digest('d', [
    'sourcemesh-diagnostic-v1',
    '1',
    item.code,
    item.severity,
    item.message,
    item.relationKind === undefined ? 'absent' : `present:${item.relationKind}`,
    item.reason === undefined ? 'absent' : `present:${item.reason}`,
    pathField,
    locationField,
    related,
    occurrence,
  ]);
}
function endpointValid(kind: EdgeKindV1, from: NodeV1, to: NodeV1): boolean {
  if (kind === 'contains')
    return (
      (from.kind === 'repository' && to.kind === 'file') ||
      (from.kind === 'file' && to.kind === 'module') ||
      (from.kind === 'module' &&
        [
          'module',
          'class',
          'interface',
          'function',
          'variable',
          'type',
        ].includes(to.kind)) ||
      (['class', 'interface'].includes(from.kind) &&
        ['function', 'variable'].includes(to.kind)) ||
      (from.kind === 'function' &&
        [
          'class',
          'interface',
          'function',
          'variable',
          'type',
          'parameter',
        ].includes(to.kind))
    );
  if (kind === 'imports') return from.kind === 'module' && to.kind === 'module';
  if (kind === 'exports')
    return (
      from.kind === 'module' &&
      ['module', 'class', 'interface', 'function', 'variable', 'type'].includes(
        to.kind,
      )
    );
  if (kind === 'extends')
    return (
      ['class', 'interface'].includes(from.kind) &&
      ['class', 'interface'].includes(to.kind)
    );
  if (kind === 'implements')
    return from.kind === 'class' && to.kind === 'interface';
  return from.kind === 'function' && to.kind === 'function';
}
function normalize(value: unknown): SnapshotV1 {
  const root = object(value, 'snapshot');
  keys(
    root,
    [
      'schemaVersion',
      'completeness',
      'repository',
      'nodes',
      'edges',
      'diagnostics',
    ],
    'snapshot',
  );
  fail(root.schemaVersion === 1, 'Invalid snapshot schema version.');
  fail(
    root.completeness === 'complete' || root.completeness === 'partial',
    'Invalid snapshot completeness.',
  );
  const repository = object(root.repository, 'repository');
  keys(repository, ['root', 'name'], 'repository');
  fail(
    pathValue(repository.root, 'repository root', true) === '.',
    'Invalid snapshot repository root.',
  );
  const nodes = array(root.nodes, 'nodes');
  const edges = array(root.edges, 'edges');
  const diagnostics = array(root.diagnostics, 'diagnostics');
  fail(
    nodes.length <= MAX_NODES &&
      edges.length <= MAX_EDGES &&
      diagnostics.length <= MAX_DIAGNOSTICS,
    'Invalid snapshot limits.',
  );
  const normalizedNodes = nodes.map(normalizeNode);
  const normalizedEdges = edges.map(normalizeEdge);
  const normalizedDiagnostics = diagnostics.map(normalizeDiagnostic);
  const nodeMap = new Map<string, NodeV1>();
  for (const node of normalizedNodes) {
    fail(!nodeMap.has(node.id), 'Invalid snapshot duplicate node.');
    nodeMap.set(node.id, node);
  }
  const edgeSet = new Set<string>();
  for (const edge of normalizedEdges) {
    fail(!edgeSet.has(edge.id), 'Invalid snapshot duplicate edge.');
    edgeSet.add(edge.id);
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    fail(
      from !== undefined &&
        to !== undefined &&
        endpointValid(edge.kind, from, to),
      'Invalid snapshot edge endpoint.',
    );
  }
  const diagSet = new Set<string>();
  for (const item of normalizedDiagnostics) {
    fail(
      !diagSet.has(item.id) && diagnosticWithId(item) === item.id,
      'Invalid snapshot diagnostic identity.',
    );
    diagSet.add(item.id);
    if (item.relatedNodeIds)
      for (const nodeId of item.relatedNodeIds)
        fail(nodeMap.has(nodeId), 'Invalid snapshot diagnostic endpoint.');
  }
  const repositoryNodes = normalizedNodes.filter(
    (node) => node.kind === 'repository',
  );
  fail(repositoryNodes.length === 1, 'Invalid snapshot repository node count.');
  const repositoryNode = repositoryNodes[0]!;
  const parentByChild = new Map<string, NodeV1>();
  for (const edge of normalizedEdges) {
    if (edge.kind !== 'contains') continue;
    fail(
      !parentByChild.has(edge.to),
      'Invalid snapshot duplicate containment.',
    );
    parentByChild.set(edge.to, nodeMap.get(edge.from)!);
  }
  const scopeCache = new Map<string, string>();
  const resolving = new Set<string>();
  const semanticParentPath = (node: NodeV1): string => {
    const cached = scopeCache.get(node.id);
    if (cached !== undefined) return cached;
    fail(!resolving.has(node.id), 'Invalid snapshot containment cycle.');
    resolving.add(node.id);
    const parent = parentByChild.get(node.id);
    let scope: string;
    if (node.kind === 'module') {
      fail(parent?.kind === 'file', 'Invalid snapshot module containment.');
      scope = `${repositoryNode.id}/${parent.id}#scope=root`;
    } else {
      fail(
        parent !== undefined &&
          parent.kind !== 'repository' &&
          parent.kind !== 'file',
        'Invalid snapshot symbol containment.',
      );
      const parentScope = semanticParentPath(parent);
      fail('qualifiedName' in parent, 'Invalid snapshot symbol parent.');
      scope = `${parentScope.slice(0, parentScope.indexOf('#scope'))}/${parent.id}#scope=${parent.kind}:${parent.qualifiedName}`;
    }
    resolving.delete(node.id);
    scopeCache.set(node.id, scope);
    return scope;
  };
  for (const node of normalizedNodes) {
    if (node.kind === 'repository' || node.kind === 'file') continue;
    fail(
      node.id ===
        nodeId(
          node.kind,
          node.path,
          semanticParentPath(node),
          node.name,
          node.memberRole,
        ),
      'Invalid snapshot node identity.',
    );
  }
  const result: SnapshotV1 = {
    schemaVersion: 1,
    completeness: root.completeness,
    repository: {
      root: '.',
      name: safeString(repository.name, 'repository name'),
    },
    nodes: normalizedNodes.sort(compareNodes),
    edges: normalizedEdges.sort(compareEdges),
    diagnostics: normalizedDiagnostics.sort(compareDiagnostics),
  };
  return structuredClone(result) as SnapshotV1;
}

const kindsV2 = new Set<NodeKindV2>([
  'repository',
  'solution',
  'project',
  'file',
  'module',
  'namespace',
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const edgeKindsV2 = new Set<EdgeKindV2>([
  'contains',
  'imports',
  'exports',
  'extends',
  'implements',
  'calls',
  'references',
  'uses',
]);

function normalizeNodeV2(value: unknown): NodeV2 {
  const item = object(value, 'node');
  const kind = safeString(item.kind, 'node kind') as NodeKindV2;
  fail(kindsV2.has(kind), 'Invalid snapshot node kind.');
  if (kind === 'repository') {
    keys(item, ['id', 'kind', 'root', 'name'], 'repository node');
    const result = {
      id: id(item.id, 'n'),
      kind: 'repository' as const,
      root: pathValue(item.root, 'repository root', true) as '.',
      name: safeString(item.name, 'repository name'),
    };
    fail(
      result.root === '.' &&
        result.id === repositoryIdV2() &&
        result.name !== '',
      'Invalid snapshot repository node.',
    );
    return result;
  }
  if (kind === 'file') {
    keys(item, ['id', 'kind', 'name', 'path', 'locations'], 'file node');
    const path = pathValue(item.path, 'file path');
    const normalizedLocations = locationsV2(item.locations);
    const result = {
      id: id(item.id, 'n'),
      kind: 'file' as const,
      name: safeString(item.name, 'file name'),
      path,
      ...(normalizedLocations === undefined
        ? {}
        : { locations: normalizedLocations }),
    };
    fail(result.id === fileIdV2(path), 'Invalid snapshot file identity.');
    return result;
  }
  keys(
    item,
    ['id', 'kind', 'name', 'path', 'qualifiedName', 'memberRole', 'locations'],
    'v2 symbol node',
  );
  const normalizedLocations = locationsV2(item.locations);
  const memberRole = safeString(item.memberRole, 'member role');
  fail(roles.has(memberRole), 'Invalid snapshot member role.');
  if (kind === 'solution' || kind === 'project' || kind === 'namespace')
    fail(memberRole === 'none', 'Invalid snapshot container node.');
  return {
    id: id(item.id, 'n'),
    kind: kind as Exclude<NodeKindV2, 'repository' | 'file'>,
    name: safeString(item.name, 'node name'),
    path: pathValue(item.path, 'node path'),
    qualifiedName: safeString(item.qualifiedName, 'qualified name'),
    memberRole: memberRole as 'none' | 'static' | 'instance',
    ...(normalizedLocations === undefined
      ? {}
      : { locations: normalizedLocations }),
  };
}

function normalizeEdgeV2(value: unknown): EdgeV2 {
  const item = object(value, 'edge');
  keys(
    item,
    ['id', 'kind', 'from', 'to', 'resolutionStatus', 'locations'],
    'edge',
  );
  const kind = safeString(item.kind, 'edge kind') as EdgeKindV2;
  fail(
    edgeKindsV2.has(kind) && item.resolutionStatus === 'resolved',
    'Invalid snapshot edge.',
  );
  const from = id(item.from, 'n');
  const to = id(item.to, 'n');
  const normalizedLocations = locationsV2(item.locations);
  const result = {
    id: id(item.id, 'e'),
    kind,
    from,
    to,
    resolutionStatus: 'resolved' as const,
    ...(normalizedLocations === undefined
      ? {}
      : { locations: normalizedLocations }),
  };
  fail(
    result.id === edgeIdV2(kind, from, to),
    'Invalid snapshot edge identity.',
  );
  return result;
}

function normalizeDiagnosticV2(
  value: unknown,
): import('../graph.js').DiagnosticV2 {
  const item = object(value, 'diagnostic');
  keys(
    item,
    [
      'id',
      'code',
      'severity',
      'message',
      'relationKind',
      'reason',
      'path',
      'location',
      'relatedNodeIds',
    ],
    'diagnostic',
  );
  const code = safeString(item.code, 'diagnostic code');
  fail(
    diagnosticCodes.has(code) &&
      (item.severity === 'warning' || item.severity === 'error'),
    'Invalid snapshot diagnostic.',
  );
  fail(item.message === messages[code], 'Invalid snapshot diagnostic message.');
  if (item.relationKind !== undefined)
    fail(
      edgeKindsV2.has(
        safeString(item.relationKind, 'relation kind') as EdgeKindV2,
      ),
      'Invalid snapshot diagnostic relation.',
    );
  if (item.reason !== undefined)
    fail(
      reasons.has(safeString(item.reason, 'diagnostic reason')),
      'Invalid snapshot diagnostic reason.',
    );
  const related =
    item.relatedNodeIds === undefined
      ? undefined
      : [
          ...new Set(
            array(item.relatedNodeIds, 'related node ids').map((v) =>
              id(v, 'n'),
            ),
          ),
        ];
  if (related) {
    fail(related.length > 0, 'Invalid snapshot diagnostic related ids.');
    related.sort(ordinal);
  }
  const normalizedPath =
    item.path === undefined
      ? undefined
      : pathValue(item.path, 'diagnostic path');
  const normalizedLocation =
    item.location === undefined ? undefined : location(item.location);
  return {
    id: id(item.id, 'd'),
    code: code as import('../graph.js').DiagnosticV2['code'],
    severity: item.severity as 'warning' | 'error',
    message: item.message as string,
    ...(item.relationKind === undefined
      ? {}
      : { relationKind: item.relationKind as EdgeKindV2 }),
    ...(item.reason === undefined
      ? {}
      : {
          reason: item.reason as NonNullable<
            import('../graph.js').DiagnosticV2['reason']
          >,
        }),
    ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
    ...(normalizedLocation === undefined
      ? {}
      : { location: normalizedLocation }),
    ...(related === undefined ? {} : { relatedNodeIds: related }),
  };
}

function diagnosticWithIdV2(item: import('../graph.js').DiagnosticV2): string {
  const locationKey =
    item.location === undefined
      ? undefined
      : `${item.location.path}#${item.location.start.line}:${item.location.start.column}-${item.location.end.line}:${item.location.end.column}`;
  return digest('d', [
    'sourcemesh-diagnostic-v2',
    '2',
    item.code,
    item.severity,
    item.message,
    item.relationKind === undefined ? 'absent' : `present:${item.relationKind}`,
    item.reason === undefined ? 'absent' : `present:${item.reason}`,
    item.path === undefined ? 'absent' : `present:${item.path}`,
    locationKey === undefined ? 'absent' : `present:${locationKey}`,
    item.relatedNodeIds === undefined
      ? 'absent'
      : JSON.stringify([...item.relatedNodeIds].sort(ordinal)),
    'occurrence',
  ]);
}

function endpointValidV2(kind: EdgeKindV2, from: NodeV2, to: NodeV2): boolean {
  if (kind === 'contains')
    return (
      (from.kind === 'repository' &&
        (to.kind === 'solution' || to.kind === 'project')) ||
      (from.kind === 'solution' && to.kind === 'project') ||
      (from.kind === 'project' && to.kind === 'file') ||
      (from.kind === 'file' && to.kind === 'module') ||
      (from.kind === 'module' &&
        [
          'module',
          'namespace',
          'class',
          'interface',
          'function',
          'variable',
          'type',
        ].includes(to.kind)) ||
      (from.kind === 'namespace' &&
        [
          'namespace',
          'class',
          'interface',
          'function',
          'variable',
          'type',
        ].includes(to.kind)) ||
      (['class', 'interface'].includes(from.kind) &&
        ['function', 'variable'].includes(to.kind)) ||
      (from.kind === 'function' &&
        [
          'class',
          'interface',
          'function',
          'variable',
          'type',
          'parameter',
        ].includes(to.kind))
    );
  if (kind === 'references')
    return from.kind === 'project' && to.kind === 'project';
  if (kind === 'uses')
    return (
      from.kind === 'module' &&
      (to.kind === 'namespace' || to.kind === 'module')
    );
  if (kind === 'imports') return from.kind === 'module' && to.kind === 'module';
  if (kind === 'exports')
    return (
      from.kind === 'module' &&
      [
        'module',
        'namespace',
        'class',
        'interface',
        'function',
        'variable',
        'type',
      ].includes(to.kind)
    );
  if (kind === 'extends')
    return (
      ['class', 'interface'].includes(from.kind) &&
      ['class', 'interface'].includes(to.kind)
    );
  if (kind === 'implements')
    return from.kind === 'class' && to.kind === 'interface';
  return from.kind === 'function' && to.kind === 'function';
}

function normalizeV2(value: unknown): SnapshotV2 {
  const root = object(value, 'snapshot');
  keys(
    root,
    [
      'schemaVersion',
      'completeness',
      'repository',
      'nodes',
      'edges',
      'diagnostics',
    ],
    'snapshot',
  );
  fail(root.schemaVersion === 2, 'Invalid snapshot schema version.');
  fail(
    root.completeness === 'complete' || root.completeness === 'partial',
    'Invalid snapshot completeness.',
  );
  const repository = object(root.repository, 'repository');
  keys(repository, ['root', 'name'], 'repository');
  fail(
    pathValue(repository.root, 'repository root', true) === '.',
    'Invalid snapshot repository root.',
  );
  const nodes = array(root.nodes, 'nodes');
  const edges = array(root.edges, 'edges');
  const diagnostics = array(root.diagnostics, 'diagnostics');
  fail(
    nodes.length <= MAX_NODES &&
      edges.length <= MAX_EDGES &&
      diagnostics.length <= MAX_DIAGNOSTICS,
    'Invalid snapshot limits.',
  );
  const normalizedNodes = nodes.map(normalizeNodeV2);
  const normalizedEdges = edges.map(normalizeEdgeV2);
  const normalizedDiagnostics = diagnostics.map(normalizeDiagnosticV2);
  const nodeMap = new Map<string, NodeV2>();
  for (const node of normalizedNodes) {
    fail(!nodeMap.has(node.id), 'Invalid snapshot duplicate node.');
    nodeMap.set(node.id, node);
  }
  const edgeSet = new Set<string>();
  const parentByChild = new Map<string, NodeV2>();
  for (const edge of normalizedEdges) {
    fail(!edgeSet.has(edge.id), 'Invalid snapshot duplicate edge.');
    edgeSet.add(edge.id);
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    fail(
      from !== undefined &&
        to !== undefined &&
        endpointValidV2(edge.kind, from, to),
      'Invalid snapshot edge endpoint.',
    );
    if (edge.kind === 'contains') {
      fail(
        !parentByChild.has(edge.to),
        'Invalid snapshot duplicate containment.',
      );
      parentByChild.set(edge.to, from!);
    }
  }
  const repositoryNodes = normalizedNodes.filter(
    (node) => node.kind === 'repository',
  );
  fail(repositoryNodes.length === 1, 'Invalid snapshot repository node count.');
  const repositoryNode = repositoryNodes[0]!;
  const scopeCache = new Map<string, string>();
  const resolving = new Set<string>();
  const semanticParentPath = (node: NodeV2): string => {
    const cached = scopeCache.get(node.id);
    if (cached !== undefined) return cached;
    fail(!resolving.has(node.id), 'Invalid snapshot containment cycle.');
    resolving.add(node.id);
    const parent = parentByChild.get(node.id);
    let scope: string;
    if (node.kind === 'solution') {
      fail(
        parent?.kind === 'repository',
        'Invalid snapshot solution containment.',
      );
      scope = `${repositoryNode.id}#scope=root`;
    } else if (node.kind === 'project') {
      fail(
        parent?.kind === 'solution' || parent?.kind === 'repository',
        'Invalid snapshot project containment.',
      );
      scope =
        parent!.kind === 'solution'
          ? `${parent!.id}#scope=solution:${parent!.qualifiedName}`
          : `${parent!.id}#scope=root`;
    } else if (node.kind === 'file') {
      fail(parent?.kind === 'project', 'Invalid snapshot file containment.');
      scope = `${parent!.id}#scope=project:${parent!.qualifiedName}`;
    } else if (node.kind === 'module') {
      fail(parent?.kind === 'file', 'Invalid snapshot module containment.');
      scope = `${parent!.id}#scope=root`;
    } else if (node.kind === 'namespace') {
      fail(
        parent?.kind === 'module' || parent?.kind === 'namespace',
        'Invalid snapshot namespace containment.',
      );
      scope = `${parent!.id}#scope=${parent!.kind}:${parent!.qualifiedName}`;
    } else {
      fail(
        parent !== undefined &&
          parent.kind !== 'repository' &&
          parent.kind !== 'file' &&
          parent.kind !== 'project',
        'Invalid snapshot symbol containment.',
      );
      scope = `${parent!.id}#scope=${parent!.kind}:${parent!.qualifiedName}`;
    }
    resolving.delete(node.id);
    scopeCache.set(node.id, scope);
    return scope;
  };
  for (const node of normalizedNodes) {
    if (node.kind === 'repository') continue;
    if (node.kind === 'file') {
      fail(node.id === fileIdV2(node.path), 'Invalid snapshot file identity.');
      semanticParentPath(node);
      continue;
    }
    fail(
      node.id ===
        nodeIdV2(
          node.kind,
          node.path,
          semanticParentPath(node),
          node.name,
          node.qualifiedName,
          node.memberRole,
        ),
      'Invalid snapshot node identity.',
    );
  }
  const diagSet = new Set<string>();
  for (const item of normalizedDiagnostics) {
    fail(
      !diagSet.has(item.id) && diagnosticWithIdV2(item) === item.id,
      'Invalid snapshot diagnostic identity.',
    );
    diagSet.add(item.id);
    for (const related of item.relatedNodeIds ?? [])
      fail(nodeMap.has(related), 'Invalid snapshot diagnostic endpoint.');
  }
  const compareV2Nodes = (left: NodeV2, right: NodeV2): number =>
    ordinal(left.kind, right.kind) || ordinal(left.id, right.id);
  return structuredClone({
    schemaVersion: 2,
    completeness: root.completeness,
    repository: {
      root: '.',
      name: safeString(repository.name, 'repository name'),
    },
    nodes: normalizedNodes.sort(compareV2Nodes),
    edges: normalizedEdges.sort(compareEdgesV2),
    diagnostics: normalizedDiagnostics.sort((left, right) =>
      ordinal(left.id, right.id),
    ),
  }) as SnapshotV2;
}

function canonical(value: unknown): Snapshot {
  const version =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  return deepFreeze(version === 2 ? normalizeV2(value) : normalize(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function encode(snapshot: Snapshot): Buffer {
  const normalized = canonical(snapshot);
  const json = JSON.stringify(normalized);
  const bytes = Buffer.from(`${json}\n`, 'utf8');
  fail(bytes.length <= MAX_BYTES, 'Invalid snapshot limits.');
  return bytes;
}
export function decode(bytes: Uint8Array): Snapshot;
export function decode(bytes: Uint8Array, version: 1 | 2): Snapshot;
export function decode(bytes: Uint8Array, version?: 1 | 2): Snapshot {
  fail(bytes.byteLength <= MAX_BYTES, 'Invalid snapshot limits.');
  const input = Buffer.from(bytes);
  fail(
    !(input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf),
    'Invalid snapshot BOM.',
  );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw invalid('Invalid snapshot encoding.');
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'schemaVersion' in parsed
    ) {
      const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
      if (
        typeof version === 'number' &&
        Number.isInteger(version) &&
        version !== 1 &&
        version !== 2
      )
        throw new SnapshotError(
          'unsupported_schema',
          'The snapshot schema is unsupported.',
          { observedVersion: version, supportedVersions: [1, 2] },
        );
    }
    if (
      version !== undefined &&
      (parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !== version)
    )
      throw invalid(
        'The snapshot version does not match the requested decoder.',
      );
    return canonical(parsed);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw invalid();
  }
}
export function snapshotDigest(bytesOrSnapshot: Uint8Array | Snapshot): string {
  const bytes =
    bytesOrSnapshot instanceof Uint8Array
      ? Buffer.from(bytesOrSnapshot)
      : encode(bytesOrSnapshot);
  return createHash('sha256').update(bytes).digest('hex');
}
export const encodeSnapshot = encode;
export const decodeSnapshot = decode;
