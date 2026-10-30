import { createHash } from 'node:crypto';

export type NodeKind =
  | 'repository'
  | 'file'
  | 'module'
  | 'class'
  | 'interface'
  | 'function'
  | 'variable'
  | 'type'
  | 'parameter';
export type NodeKindV2 = NodeKind | 'solution' | 'project' | 'namespace';
export type MemberRole = 'none' | 'static' | 'instance';

export interface PositionV1 {
  readonly line: number;
  readonly column: number;
}
export interface LocationV1 {
  readonly path: string;
  readonly start: PositionV1;
  readonly end: PositionV1;
}
export interface RepositoryNodeV1 {
  readonly id: string;
  readonly kind: 'repository';
  readonly root: '.';
  readonly name: string;
}
export interface FileNodeV1 {
  readonly id: string;
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  readonly locations?: readonly LocationV1[];
}
export interface SymbolNodeV1 {
  readonly id: string;
  readonly kind: Exclude<NodeKind, 'repository' | 'file'>;
  readonly name: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly memberRole: MemberRole;
  readonly locations?: readonly LocationV1[];
}
export type NodeV1 = RepositoryNodeV1 | FileNodeV1 | SymbolNodeV1;

export type EdgeKindV1 =
  'contains' | 'imports' | 'exports' | 'extends' | 'implements' | 'calls';
export type EdgeKindV2 = EdgeKindV1 | 'references' | 'uses';
export type RelationEvidence = 'semantic' | 'syntactic' | 'inferred';

export interface EdgeV1 {
  readonly id: string;
  readonly kind: EdgeKindV1;
  readonly from: string;
  readonly to: string;
  readonly resolutionStatus: 'resolved';
  readonly locations?: readonly LocationV1[];
}
export interface V2ContainerNode {
  readonly id: string;
  readonly kind: 'solution' | 'project' | 'namespace';
  readonly name: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly memberRole: 'none';
  readonly locations?: readonly LocationV1[];
}
export type RepositoryNodeV2 = RepositoryNodeV1;
export type FileNodeV2 = FileNodeV1;
export interface SymbolNodeV2 {
  readonly id: string;
  readonly kind: Exclude<NodeKindV2, 'repository' | 'file'>;
  readonly name: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly memberRole: MemberRole;
  readonly locations?: readonly LocationV1[];
}
export type NodeV2 =
  RepositoryNodeV2 | FileNodeV2 | SymbolNodeV2 | V2ContainerNode;
export interface EdgeV2 {
  readonly id: string;
  readonly kind: EdgeKindV2;
  readonly from: string;
  readonly to: string;
  readonly resolutionStatus: 'resolved';
  readonly locations?: readonly LocationV1[];
}
/**
 * Schema v3 keeps v2 identities but records which local pack emitted every
 * queryable relationship. Containment is Core-owned structure, not evidence.
 */
export type EdgeV3 =
  | (EdgeV2 & { readonly kind: 'contains' })
  | (EdgeV2 & {
      readonly kind: Exclude<EdgeKindV2, 'contains'>;
      readonly packId: string;
      readonly evidence: RelationEvidence;
    });
export interface PackAttribution {
  readonly packId: string;
  readonly language: string;
}
export type FileNodeV3 = FileNodeV2 & PackAttribution;
export type SymbolNodeV3 = SymbolNodeV2 & PackAttribution;
export type NodeV3 = RepositoryNodeV2 | FileNodeV3 | SymbolNodeV3;
export type GraphDiagnosticCode =
  | 'unsupported_declaration'
  | 'duplicate_declaration'
  | 'declaration.unstable_identity'
  | 'graph.node_id_collision'
  | 'relationship_external'
  | 'relationship_unresolved'
  | 'relationship_ambiguous'
  | 'relationship_dynamic'
  | 'relationship_unsupported'
  | 'relationship_missing_source';
export interface DiagnosticV1 {
  readonly id: string;
  readonly code: GraphDiagnosticCode;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly relationKind?: EdgeKindV1;
  readonly reason?:
    | 'external-target'
    | 'unresolved-target'
    | 'ambiguous-target'
    | 'dynamic-target'
    | 'unsupported-relation'
    | 'missing-source-node';
  readonly path?: string;
  readonly location?: LocationV1;
  readonly relatedNodeIds?: readonly string[];
}
export interface DeclarationGraph {
  readonly schemaVersion: 1;
  readonly repository: { readonly root: '.'; readonly name: string };
  readonly nodes: readonly NodeV1[];
  readonly edges: readonly EdgeV1[];
  readonly diagnostics: readonly DiagnosticV1[];
}
export interface DeclarationGraphV2 {
  readonly schemaVersion: 2;
  readonly repository: { readonly root: '.'; readonly name: string };
  readonly nodes: readonly NodeV2[];
  readonly edges: readonly EdgeV2[];
  readonly diagnostics: readonly DiagnosticV2[];
}
export interface DeclarationGraphV3 {
  readonly schemaVersion: 3;
  readonly repository: { readonly root: '.'; readonly name: string };
  readonly nodes: readonly NodeV3[];
  readonly edges: readonly EdgeV3[];
  readonly diagnostics: readonly DiagnosticV2[];
}
export interface DiagnosticV2 extends Omit<
  DiagnosticV1,
  'relationKind' | 'reason'
> {
  readonly relationKind?: EdgeKindV2;
  readonly reason?: NonNullable<DiagnosticV1['reason']>;
}

function ordinal(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

export function frame(fields: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(fields.length, 0);
  parts.push(count);
  for (const value of fields) {
    const bytes = Buffer.from(value.normalize('NFC'), 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

export function digest(
  prefix: 'n' | 'e' | 'd' | 'b',
  fields: readonly string[],
): string {
  return `${prefix}:${createHash('sha256').update(frame(fields)).digest('hex')}`;
}

export function repositoryId(): string {
  return digest('n', ['sourcemesh-repository-v1', '1', 'repository']);
}
export function fileId(relativePath: string): string {
  return digest('n', ['sourcemesh-file-v1', '1', relativePath]);
}
export function nodeId(
  kind: Exclude<NodeKind, 'repository' | 'file'>,
  relativePath: string,
  semanticParentPath: string,
  name: string,
  memberRole: MemberRole,
): string {
  return digest('n', [
    'sourcemesh-node-v1',
    '1',
    kind,
    relativePath,
    semanticParentPath,
    name,
    memberRole,
  ]);
}
export function edgeId(kind: EdgeKindV1, from: string, to: string): string {
  return digest('e', ['sourcemesh-edge-v1', '1', kind, from, to]);
}

export function repositoryIdV2(): string {
  return digest('n', ['sourcemesh-repository-v2', '2', 'repository']);
}
const nodeKindsV2 = new Set<NodeKindV2>([
  'solution',
  'project',
  'module',
  'namespace',
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const memberRolesV2 = new Set<MemberRole>(['none', 'static', 'instance']);
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
function v2Path(value: string): string {
  const normalized = v2Text(value, 'path');
  if (
    normalized.length === 0 ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  )
    throw new TypeError(
      'V2 identity paths must be canonical repository-relative paths.',
    );
  return normalized;
}
function v2Text(value: string, label: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError(`V2 identity ${label} must be valid Unicode text.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`V2 identity ${label} must be valid Unicode text.`);
    }
  }
  const normalized = value.normalize('NFC');
  if (normalized.length === 0 || normalized.includes('\0'))
    throw new TypeError(`V2 identity ${label} must be non-empty UTF-8 text.`);
  return normalized;
}
function v2IdentityText(value: string, label: string): string {
  const normalized = v2Text(value, label);
  if (
    normalized.includes('\\') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    normalized.split('/').some((part) => part === '.' || part === '..')
  )
    throw new TypeError(`V2 identity ${label} must be canonical text.`);
  return normalized;
}
export function fileIdV2(relativePath: string): string {
  return digest('n', ['sourcemesh-file-v2', '2', 'file', v2Path(relativePath)]);
}
export function nodeIdV2(
  kind: Exclude<NodeKindV2, 'repository' | 'file'>,
  relativePath: string,
  semanticParentPath: string,
  name: string,
  qualifiedName: string,
  memberRole: MemberRole,
): string {
  if (!nodeKindsV2.has(kind)) throw new TypeError('Invalid V2 node kind.');
  if (!memberRolesV2.has(memberRole))
    throw new TypeError('Invalid V2 member role.');
  const normalizedKind = v2Text(kind, 'kind');
  const normalizedParent = v2IdentityText(
    semanticParentPath,
    'semantic parent',
  );
  const normalizedName = v2IdentityText(name, 'name');
  const normalizedQualifiedName = v2IdentityText(
    qualifiedName,
    'qualified name',
  );
  const normalizedRole = v2Text(memberRole, 'member role');
  return digest('n', [
    'sourcemesh-node-v2',
    '2',
    normalizedKind,
    v2Path(relativePath),
    normalizedParent,
    normalizedName,
    normalizedQualifiedName,
    normalizedRole,
  ]);
}
export function edgeIdV2(kind: EdgeKindV2, from: string, to: string): string {
  if (!edgeKindsV2.has(kind)) throw new TypeError('Invalid V2 edge kind.');
  return digest('e', ['sourcemesh-edge-v2', '2', kind, from, to]);
}

export function compareLocations(left: LocationV1, right: LocationV1): number {
  return (
    ordinal(left.path, right.path) ||
    left.start.line - right.start.line ||
    left.start.column - right.start.column ||
    left.end.line - right.end.line ||
    left.end.column - right.end.column
  );
}

export function sortLocations(locations: readonly LocationV1[]): LocationV1[] {
  const sorted = [...locations].sort(compareLocations);
  return sorted.filter(
    (location, index) =>
      index === 0 || compareLocations(location, sorted[index - 1]!) !== 0,
  );
}

export function compareNodes(left: NodeV1, right: NodeV1): number {
  return ordinal(left.kind, right.kind) || ordinal(left.id, right.id);
}
export function compareEdges(left: EdgeV1, right: EdgeV1): number {
  return (
    ordinal(left.kind, right.kind) ||
    ordinal(left.from, right.from) ||
    ordinal(left.to, right.to) ||
    ordinal(left.id, right.id)
  );
}
export function compareEdgesV2(left: EdgeV2, right: EdgeV2): number {
  return (
    ordinal(left.kind, right.kind) ||
    ordinal(left.from, right.from) ||
    ordinal(left.to, right.to) ||
    ordinal(left.id, right.id)
  );
}
export function compareDiagnostics(
  left: DiagnosticV1,
  right: DiagnosticV1,
): number {
  return (
    compareOptional(left.path, right.path) ||
    compareOptional(locationKey(left.location), locationKey(right.location)) ||
    ordinal(left.code, right.code) ||
    ordinal(left.severity, right.severity) ||
    ordinal(left.message, right.message) ||
    ordinal(left.relationKind ?? '', right.relationKind ?? '') ||
    ordinal(left.reason ?? '', right.reason ?? '') ||
    ordinal(
      JSON.stringify(left.relatedNodeIds ?? []),
      JSON.stringify(right.relatedNodeIds ?? []),
    ) ||
    ordinal(left.id, right.id)
  );
}
function compareOptional(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === undefined && right !== undefined) return 1;
  if (left !== undefined && right === undefined) return -1;
  return left === undefined || right === undefined ? 0 : ordinal(left, right);
}
function locationKey(location: LocationV1 | undefined): string {
  return location === undefined
    ? ''
    : `${location.path}#${location.start.line}:${location.start.column}-${location.end.line}:${location.end.column}`;
}
