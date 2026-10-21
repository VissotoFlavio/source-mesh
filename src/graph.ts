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

export interface EdgeV1 {
  readonly id: string;
  readonly kind: 'contains';
  readonly from: string;
  readonly to: string;
  readonly resolutionStatus: 'resolved';
  readonly locations?: readonly LocationV1[];
}
export type GraphDiagnosticCode =
  | 'unsupported_declaration'
  | 'duplicate_declaration'
  | 'declaration.unstable_identity'
  | 'graph.node_id_collision';
export interface DiagnosticV1 {
  readonly id: string;
  readonly code: GraphDiagnosticCode;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly path?: string;
  readonly location?: LocationV1;
}
export interface DeclarationGraph {
  readonly schemaVersion: 1;
  readonly repository: { readonly root: '.'; readonly name: string };
  readonly nodes: readonly NodeV1[];
  readonly edges: readonly EdgeV1[];
  readonly diagnostics: readonly DiagnosticV1[];
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
export function edgeId(kind: 'contains', from: string, to: string): string {
  return digest('e', ['sourcemesh-edge-v1', '1', kind, from, to]);
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
export function compareDiagnostics(
  left: DiagnosticV1,
  right: DiagnosticV1,
): number {
  return (
    compareOptional(left.path, right.path) ||
    compareOptional(locationKey(left.location), locationKey(right.location)) ||
    ordinal(left.code, right.code) ||
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
