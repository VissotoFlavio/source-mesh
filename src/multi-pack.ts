import {
  digest,
  edgeIdV2,
  fileIdV2,
  nodeIdV2,
  repositoryIdV2,
  type DiagnosticV2,
  type EdgeV3,
  type NodeV2,
  type NodeV3,
} from './graph.js';
import type { LanguagePackManifest } from './packs.js';
import { typescriptPack } from './packs/typescript.js';
import type { SnapshotV1, SnapshotV3 } from './snapshot/types.js';

function ordinal(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function metadata(
  manifest: LanguagePackManifest,
  language: string,
): SnapshotV3['metadata']['packs'][number] {
  return {
    id: manifest.id,
    language,
    version: manifest.version,
    capabilities: [...manifest.capabilities].sort(ordinal),
  };
}

const TYPESCRIPT_PACK = metadata(typescriptPack.manifest, 'typescript');

function parentScope(
  node: Exclude<NodeV2['kind'], 'repository'>,
  parent: NodeV2,
): string {
  if (node === 'solution') return `${parent.id}#scope=root`;
  if (node === 'project')
    return parent.kind === 'solution'
      ? `${parent.id}#scope=solution:${parent.qualifiedName}`
      : `${parent.id}#scope=root`;
  if (node === 'file')
    return `${parent.id}#scope=project:${
      'qualifiedName' in parent ? parent.qualifiedName : ''
    }`;
  if (node === 'module') return `${parent.id}#scope=root`;
  return `${parent.id}#scope=${parent.kind}:${
    'qualifiedName' in parent ? parent.qualifiedName : ''
  }`;
}

function diagnosticId(item: Omit<DiagnosticV2, 'id'>): string {
  const location =
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
    location,
    item.relatedNodeIds === undefined
      ? 'absent'
      : JSON.stringify([...item.relatedNodeIds].sort(ordinal)),
    'occurrence',
  ]);
}

function v3Node(
  node: NodeV2,
  pack: { readonly id: string; readonly language: string },
): NodeV3 {
  if (node.kind === 'repository') return node;
  const locations = node.locations?.slice(0, 1);
  return {
    ...node,
    ...(locations === undefined ? {} : { locations }),
    packId: pack.id,
    language: pack.language,
  } as NodeV3;
}

function assertUnique(
  values: readonly { readonly id: string }[],
  label: string,
): void {
  if (new Set(values.map((value) => value.id)).size !== values.length)
    throw new TypeError(`Multi-pack ${label} must have unique identities.`);
}

/**
 * Combines two locally-produced declaration graphs without creating any
 * relationship across packs. TypeScript v1 declarations are re-identified
 * under a synthetic v2 project so schema-v3 containment remains valid.
 */
export function composeMultiPackSnapshot(
  typescript: SnapshotV1,
  csharp: SnapshotV3,
): SnapshotV3 {
  const csharpRepository = csharp.nodes.find(
    (
      node,
    ): node is Extract<SnapshotV3['nodes'][number], { kind: 'repository' }> =>
      node.kind === 'repository',
  );
  const typescriptRepository = typescript.nodes.find(
    (node) => node.kind === 'repository',
  );
  if (
    csharpRepository === undefined ||
    typescriptRepository === undefined ||
    csharpRepository.id !== repositoryIdV2() ||
    csharpRepository.name !== typescriptRepository.name
  )
    throw new TypeError('Multi-pack repository identities do not agree.');

  const project: NodeV2 = {
    id: nodeIdV2(
      'project',
      'typescript.pack',
      `${csharpRepository.id}#scope=root`,
      'typescript',
      'typescript',
      'none',
    ),
    kind: 'project',
    name: 'typescript',
    path: 'typescript.pack',
    qualifiedName: 'typescript',
    memberRole: 'none',
  };
  const parentByChild = new Map<string, string>();
  for (const edge of typescript.edges)
    if (edge.kind === 'contains') parentByChild.set(edge.to, edge.from);

  const typescriptNodes = new Map<string, NodeV2>();
  typescriptNodes.set(typescriptRepository.id, csharpRepository);
  const typescriptEdges: EdgeV3[] = [
    {
      id: edgeIdV2('contains', csharpRepository.id, project.id),
      kind: 'contains',
      from: csharpRepository.id,
      to: project.id,
      resolutionStatus: 'resolved',
    },
  ];

  const convertNode = (id: string): NodeV2 => {
    const existing = typescriptNodes.get(id);
    if (existing !== undefined) return existing;
    const source = typescript.nodes.find((node) => node.id === id);
    const parentId = parentByChild.get(id);
    if (source === undefined || parentId === undefined)
      throw new TypeError('TypeScript graph containment is incomplete.');
    const parent =
      parentId === typescriptRepository.id ? project : convertNode(parentId);
    let converted: NodeV2;
    if (source.kind === 'file') {
      converted = {
        id: fileIdV2(source.path),
        kind: 'file',
        name: source.name,
        path: source.path,
        ...(source.locations === undefined
          ? {}
          : { locations: source.locations }),
      };
    } else if (source.kind !== 'repository') {
      converted = {
        id: nodeIdV2(
          source.kind,
          source.path,
          parentScope(source.kind, parent),
          source.name,
          source.qualifiedName,
          source.memberRole,
        ),
        kind: source.kind,
        name: source.name,
        path: source.path,
        qualifiedName: source.qualifiedName,
        memberRole: source.memberRole,
        ...(source.locations === undefined
          ? {}
          : { locations: source.locations }),
      };
    } else {
      return csharpRepository;
    }
    typescriptNodes.set(id, converted);
    typescriptEdges.push({
      id: edgeIdV2('contains', parent.id, converted.id),
      kind: 'contains',
      from: parent.id,
      to: converted.id,
      resolutionStatus: 'resolved',
      ...(source.locations === undefined
        ? {}
        : { locations: source.locations }),
    });
    return converted;
  };

  for (const node of typescript.nodes)
    if (node.kind !== 'repository') convertNode(node.id);
  for (const edge of typescript.edges) {
    if (edge.kind === 'contains') continue;
    const from = convertNode(edge.from);
    const to = convertNode(edge.to);
    typescriptEdges.push({
      id: edgeIdV2(edge.kind, from.id, to.id),
      kind: edge.kind,
      from: from.id,
      to: to.id,
      resolutionStatus: 'resolved',
      ...(edge.locations === undefined ? {} : { locations: edge.locations }),
      packId: TYPESCRIPT_PACK.id,
      evidence: 'semantic',
    });
  }

  const typescriptDiagnostics = typescript.diagnostics.map((diagnostic) => {
    const relatedNodeIds = diagnostic.relatedNodeIds?.map(
      (id) => convertNode(id).id,
    );
    const converted: Omit<DiagnosticV2, 'id'> = {
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.relationKind === undefined
        ? {}
        : { relationKind: diagnostic.relationKind }),
      ...(diagnostic.reason === undefined ? {} : { reason: diagnostic.reason }),
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      ...(diagnostic.location === undefined
        ? {}
        : { location: diagnostic.location }),
      ...(relatedNodeIds === undefined ? {} : { relatedNodeIds }),
    };
    return { ...converted, id: diagnosticId(converted) };
  });

  const csharpNodes = csharp.nodes.filter((node) => node.kind !== 'repository');
  const nodes = [
    csharpRepository,
    v3Node(project, TYPESCRIPT_PACK),
    ...[...typescriptNodes.entries()]
      .filter(([id]) => id !== typescriptRepository.id)
      .map(([, node]) => v3Node(node, TYPESCRIPT_PACK)),
    ...csharpNodes,
  ];
  const csharpEdges = csharp.edges;
  const edges = [...typescriptEdges, ...csharpEdges];
  const diagnostics = [...typescriptDiagnostics, ...csharp.diagnostics];
  assertUnique(nodes, 'nodes');
  assertUnique(edges, 'edges');
  assertUnique(diagnostics, 'diagnostics');

  return {
    schemaVersion: 3,
    completeness:
      typescript.completeness === 'partial' || csharp.completeness === 'partial'
        ? 'partial'
        : 'complete',
    repository: { root: '.', name: csharp.repository.name },
    metadata: {
      verification: 'unverified',
      packs: [...csharp.metadata.packs, TYPESCRIPT_PACK],
    },
    nodes: nodes.sort(
      (left, right) =>
        ordinal(left.kind, right.kind) || ordinal(left.id, right.id),
    ),
    edges: edges.sort(
      (left, right) =>
        ordinal(left.kind, right.kind) ||
        ordinal(left.from, right.from) ||
        ordinal(left.to, right.to) ||
        ordinal(left.id, right.id),
    ),
    diagnostics: diagnostics.sort((left, right) => ordinal(left.id, right.id)),
  } as SnapshotV3;
}
