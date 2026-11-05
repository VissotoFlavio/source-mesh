import path from 'node:path';
import {
  compareEdgesV2,
  digest,
  edgeIdV2,
  fileIdV2,
  nodeIdV2,
  repositoryIdV2,
  sortLocations,
  type DiagnosticV2,
  type EdgeKindV2,
  type EdgeV2,
  type EdgeV3,
  type LocationV1,
  type NodeKindV2,
  type NodeV2,
} from '../../graph.js';
import type { SnapshotV3 } from '../../snapshot/types.js';
import type {
  CSharpAnalysisManifest,
  CSharpManifest,
  CSharpWorkerLocation,
  CSharpWorkerRelationship,
  CSharpWorkerSymbol,
} from './contracts.js';
import type { CSharpWorkerResult } from './worker.js';

export interface ExtractCSharpDeclarationGraphRequest {
  readonly repositoryRoot: string;
  readonly manifest: CSharpAnalysisManifest;
  readonly worker: CSharpWorkerResult;
  readonly repositoryName?: string;
}

function isLegacyManifest(
  manifest: CSharpAnalysisManifest,
): manifest is CSharpManifest {
  return manifest.selection.kind !== 'explicit-projects';
}

type LogicalKind = Exclude<NodeKindV2, 'repository'>;

interface LogicalSymbol {
  readonly kind: LogicalKind;
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly memberRole: 'none' | 'static' | 'instance';
}

interface Candidate {
  readonly symbol: LogicalSymbol;
  readonly parentKey: string;
  readonly locations: LocationV1[];
}

type PendingDiagnostic = Omit<DiagnosticV2, 'id'>;

const messages: Record<DiagnosticV2['code'], string> = {
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

function ordinal(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function symbolKey(symbol: {
  readonly kind: string;
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly memberRole: string;
}): string {
  return JSON.stringify([
    symbol.kind,
    symbol.path,
    symbol.name,
    symbol.qualifiedName,
    symbol.memberRole,
  ]);
}

function logical(symbol: CSharpWorkerSymbol): LogicalSymbol {
  return { ...symbol };
}

function location(value: CSharpWorkerLocation): LocationV1 {
  return {
    path: value.path,
    start: { ...value.start },
    end: { ...value.end },
  };
}

function candidateSymbol(
  kind: LogicalKind,
  pathName: string,
  name: string,
  qualifiedName: string,
  memberRole: LogicalSymbol['memberRole'] = 'none',
): LogicalSymbol {
  return { kind, path: pathName, name, qualifiedName, memberRole };
}

function basename(relativePath: string, suffixes: readonly string[]): string {
  const name = path.posix.basename(relativePath);
  const lower = name.toLowerCase();
  const suffix = suffixes.find((item) => lower.endsWith(item));
  return suffix === undefined ? name : name.slice(0, -suffix.length);
}

function repositoryName(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 0x20)
  )
    return 'repository';
  return value.normalize('NFC');
}

function parentScope(childKind: LogicalKind, parent: NodeV2): string {
  if (childKind === 'solution') return `${parent.id}#scope=root`;
  if (childKind === 'project')
    return parent.kind === 'solution'
      ? `${parent.id}#scope=solution:${parent.qualifiedName}`
      : `${parent.id}#scope=root`;
  if (childKind === 'file')
    return `${parent.id}#scope=project:${
      'qualifiedName' in parent ? parent.qualifiedName : ''
    }`;
  if (childKind === 'module') return `${parent.id}#scope=root`;
  return `${parent.id}#scope=${parent.kind}:${
    'qualifiedName' in parent ? parent.qualifiedName : ''
  }`;
}

function diagnosticId(item: PendingDiagnostic): string {
  const locationKey =
    item.location === undefined
      ? 'absent'
      : `present:${item.location.path}#${item.location.start.line}:${item.location.start.column}-${item.location.end.line}:${item.location.end.column}`;
  return digest('d', [
    'sourcemesh-diagnostic-v2',
    '2',
    item.code,
    item.severity,
    item.message,
    item.relationKind === undefined ? 'absent' : `present:${item.relationKind}`,
    item.reason === undefined ? 'absent' : `present:${item.reason}`,
    item.path === undefined ? 'absent' : `present:${item.path}`,
    locationKey,
    item.relatedNodeIds === undefined
      ? 'absent'
      : JSON.stringify([...item.relatedNodeIds].sort(ordinal)),
    'occurrence',
  ]);
}

function addLocations(
  target: Map<string, LocationV1[]>,
  key: string,
  locations: readonly LocationV1[],
): void {
  const existing = target.get(key) ?? [];
  existing.push(...locations);
  target.set(key, existing);
}

function relationDiagnostic(
  relationship: CSharpWorkerRelationship,
  code: DiagnosticV2['code'],
): PendingDiagnostic {
  const locationValue =
    relationship.location === undefined
      ? undefined
      : location(relationship.location);
  const relationKind = relationship.kind as EdgeKindV2;
  const reason: NonNullable<DiagnosticV2['reason']> =
    code === 'relationship_external'
      ? 'external-target'
      : code === 'relationship_ambiguous'
        ? 'ambiguous-target'
        : code === 'relationship_dynamic'
          ? 'dynamic-target'
          : code === 'relationship_missing_source'
            ? 'missing-source-node'
            : code === 'relationship_unsupported'
              ? 'unsupported-relation'
              : 'unresolved-target';
  return {
    code,
    severity: code === 'relationship_missing_source' ? 'error' : 'warning',
    message: messages[code],
    relationKind,
    reason,
    path: locationValue?.path ?? relationship.source.path,
    ...(locationValue === undefined ? {} : { location: locationValue }),
  };
}

export function extractCSharpDeclarationGraph(
  request: ExtractCSharpDeclarationGraphRequest,
): SnapshotV3 {
  // The root is intentionally not used in identity construction. All paths
  // reaching this adapter have already crossed the contained discovery gate.
  void request.repositoryRoot;
  const repository: NodeV2 = {
    id: repositoryIdV2(),
    kind: 'repository',
    root: '.',
    name: repositoryName(request.repositoryName),
  };
  const repositoryKey = symbolKey({
    kind: 'repository',
    path: '.',
    name: repository.name,
    qualifiedName: '.',
    memberRole: 'none',
  });
  const nodes: NodeV2[] = [repository];
  const nodeByKey = new Map<string, NodeV2>([[repositoryKey, repository]]);
  const locationsByEdge = new Map<string, LocationV1[]>();
  const edgesByKey = new Map<string, EdgeV2>();
  const candidates = new Map<string, Candidate>();
  const collisionKeys = new Set<string>();
  const pendingDiagnostics = new Map<string, PendingDiagnostic>();

  const addDiagnostic = (item: PendingDiagnostic): void => {
    const normalized: PendingDiagnostic = {
      ...item,
      ...(item.relatedNodeIds === undefined
        ? {}
        : { relatedNodeIds: [...new Set(item.relatedNodeIds)].sort(ordinal) }),
    };
    pendingDiagnostics.set(
      JSON.stringify({ ...normalized, id: undefined }),
      normalized,
    );
  };

  const addEdge = (
    kind: EdgeKindV2,
    from: NodeV2,
    to: NodeV2,
    edgeLocations: readonly LocationV1[] = [],
  ): void => {
    const key = `${kind}\0${from.id}\0${to.id}`;
    addLocations(locationsByEdge, key, edgeLocations);
    if (!edgesByKey.has(key))
      edgesByKey.set(key, {
        id: edgeIdV2(kind, from.id, to.id),
        kind,
        from: from.id,
        to: to.id,
        resolutionStatus: 'resolved',
      });
  };

  const addLogical = (
    value: LogicalSymbol,
    parentKey: string,
    valueLocations: readonly LocationV1[] = [],
  ): string => {
    const key = symbolKey(value);
    const current = candidates.get(key);
    if (current !== undefined) {
      if (current.parentKey !== parentKey) collisionKeys.add(key);
      else current.locations.push(...valueLocations);
      return key;
    }
    candidates.set(key, {
      symbol: value,
      parentKey,
      locations: [...valueLocations],
    });
    return key;
  };

  const projectKeys = new Map<string, string>();
  const projectOwner = new Map<string, string>();
  const solution = isLegacyManifest(request.manifest)
    ? request.manifest.solution
    : undefined;
  const solutionKey = solution
    ? symbolKey(
        candidateSymbol(
          'solution',
          solution.path,
          basename(solution.path, ['.slnx', '.sln']),
          basename(solution.path, ['.slnx', '.sln']),
        ),
      )
    : undefined;
  if (solution !== undefined) {
    addLogical(
      candidateSymbol(
        'solution',
        solution.path,
        basename(solution.path, ['.slnx', '.sln']),
        basename(solution.path, ['.slnx', '.sln']),
      ),
      repositoryKey,
    );
  }
  for (const project of request.manifest.projects) {
    const name = basename(project.path, ['.csproj']);
    const key = addLogical(
      candidateSymbol('project', project.path, name, name),
      solutionKey ?? repositoryKey,
    );
    projectKeys.set(project.path, key);
    for (const file of project.files) {
      if (!projectOwner.has(file)) projectOwner.set(file, project.path);
    }
  }
  for (const file of [...projectOwner.keys()].sort(ordinal)) {
    const key = addLogical(
      candidateSymbol('file', file, path.posix.basename(file), file),
      projectKeys.get(projectOwner.get(file)!)!,
    );
    const module = candidateSymbol('module', file, file, file);
    addLogical(module, key);
  }

  for (const project of request.worker.projects) {
    for (const declaration of project.declarations ?? []) {
      const declarationSymbol = logical(declaration);
      addLogical(
        declarationSymbol,
        symbolKey(declaration.parent),
        declaration.locations.map(location),
      );
    }
  }

  const ensureNode = (key: string): NodeV2 | undefined => {
    const existing = nodeByKey.get(key);
    if (existing !== undefined) return existing;
    if (collisionKeys.has(key)) return undefined;
    const candidate = candidates.get(key);
    if (candidate === undefined) return undefined;
    const parent = ensureNode(candidate.parentKey);
    if (parent === undefined) return undefined;
    const value = candidate.symbol;
    const id =
      value.kind === 'file'
        ? fileIdV2(value.path)
        : nodeIdV2(
            value.kind,
            value.path,
            parentScope(value.kind, parent),
            value.name,
            value.qualifiedName,
            value.memberRole,
          );
    const normalizedLocations = sortLocations(candidate.locations);
    const node: NodeV2 =
      value.kind === 'file'
        ? {
            id,
            kind: 'file',
            name: value.name,
            path: value.path,
            ...(normalizedLocations.length === 0
              ? {}
              : { locations: normalizedLocations }),
          }
        : {
            id,
            kind: value.kind,
            name: value.name,
            path: value.path,
            qualifiedName: value.qualifiedName,
            memberRole: value.memberRole,
            ...(normalizedLocations.length === 0
              ? {}
              : { locations: normalizedLocations }),
          };
    nodeByKey.set(key, node);
    nodes.push(node);
    addEdge('contains', parent, node, normalizedLocations);
    return node;
  };

  for (const key of candidates.keys()) ensureNode(key);

  for (const project of request.manifest.projects) {
    const from = ensureNode(projectKeys.get(project.path)!);
    if (from === undefined) continue;
    for (const reference of project.references) {
      const to = ensureNode(projectKeys.get(reference) ?? '');
      if (to === undefined) {
        addDiagnostic({
          code: 'relationship_unresolved',
          severity: 'warning',
          message: messages.relationship_unresolved,
          relationKind: 'references',
          reason: 'unresolved-target',
          path: project.path,
        });
      } else addEdge('references', from, to);
    }
  }

  const statusCodes: Record<
    Exclude<CSharpWorkerRelationship['status'], 'resolved'>,
    DiagnosticV2['code']
  > = {
    external: 'relationship_external',
    unresolved: 'relationship_unresolved',
    ambiguous: 'relationship_ambiguous',
    dynamic: 'relationship_dynamic',
    unsupported: 'relationship_unsupported',
    'missing-source': 'relationship_missing_source',
  };
  for (const project of request.worker.projects) {
    for (const relationship of project.relationships ?? []) {
      if (relationship.status !== 'resolved') {
        addDiagnostic(
          relationDiagnostic(relationship, statusCodes[relationship.status]),
        );
        continue;
      }
      const from = ensureNode(symbolKey(relationship.source));
      const to =
        relationship.target === undefined
          ? undefined
          : ensureNode(symbolKey(relationship.target));
      if (from === undefined) {
        addDiagnostic(
          relationDiagnostic(relationship, 'relationship_missing_source'),
        );
        continue;
      }
      if (to === undefined) {
        addDiagnostic(
          relationDiagnostic(relationship, 'relationship_unresolved'),
        );
        continue;
      }
      const kind = relationship.kind as EdgeKindV2;
      const valid =
        (kind === 'uses' &&
          from.kind === 'module' &&
          ['namespace', 'module'].includes(to.kind)) ||
        (kind === 'extends' &&
          ['class', 'interface'].includes(from.kind) &&
          ['class', 'interface'].includes(to.kind)) ||
        (kind === 'implements' &&
          from.kind === 'class' &&
          to.kind === 'interface') ||
        (kind === 'calls' &&
          from.kind === 'function' &&
          to.kind === 'function');
      if (!valid) {
        addDiagnostic(
          relationDiagnostic(relationship, 'relationship_unsupported'),
        );
        continue;
      }
      addEdge(
        kind,
        from,
        to,
        relationship.location === undefined
          ? []
          : [location(relationship.location)],
      );
    }
  }

  for (const key of collisionKeys) {
    const candidate = candidates.get(key);
    if (candidate === undefined) continue;
    addDiagnostic({
      code: 'graph.node_id_collision',
      severity: 'error',
      message: messages['graph.node_id_collision'],
      path: candidate.symbol.path,
      ...(candidate.locations[0] === undefined
        ? {}
        : { location: candidate.locations[0] }),
    });
  }

  const edges = [...edgesByKey.values()]
    .map((edge) => {
      const locations = sortLocations(
        locationsByEdge.get(`${edge.kind}\0${edge.from}\0${edge.to}`) ?? [],
      );
      return locations.length === 0 ? edge : { ...edge, locations };
    })
    .sort(compareEdgesV2);
  const diagnostics = [...pendingDiagnostics.values()]
    .map((item) => ({ ...item, id: diagnosticId(item) }) as DiagnosticV2)
    .sort((left, right) => ordinal(left.id, right.id));
  const completeness: SnapshotV3['completeness'] = diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error',
  )
    ? 'partial'
    : 'complete';
  const snapshot = {
    schemaVersion: 2 as const,
    completeness,
    repository: { root: '.' as const, name: repository.name },
    nodes: nodes.sort(
      (left, right) =>
        ordinal(left.kind, right.kind) || ordinal(left.id, right.id),
    ),
    edges,
    diagnostics,
  };
  return {
    ...snapshot,
    schemaVersion: 3,
    metadata: {
      verification: 'unverified',
      packs: [
        {
          id: 'csharp',
          language: 'csharp',
          version: '1.0.0',
          capabilities: ['project-manifest', 'source-analysis'],
        },
      ],
    },
    nodes: snapshot.nodes.map((node) =>
      node.kind === 'repository'
        ? node
        : { ...node, packId: 'csharp', language: 'csharp' },
    ),
    edges: snapshot.edges.map((edge): EdgeV3 =>
      edge.kind === 'contains'
        ? (edge as EdgeV3)
        : { ...edge, packId: 'csharp', evidence: 'syntactic' as const },
    ),
  };
}

export const extractCSharpGraph = extractCSharpDeclarationGraph;
