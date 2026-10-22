import { createHash } from 'node:crypto';
import {
  type EdgeV1,
  type FileNodeV1,
  type LocationV1,
  type MemberRole,
  type NodeKind,
  type NodeV1,
  type SymbolNodeV1,
} from './graph.js';
import { snapshotDigest } from './snapshot/codec.js';
import type { SnapshotV1 } from './snapshot/types.js';

export type SearchSymbolKindV1 = Exclude<
  NodeKind,
  'repository' | 'file' | 'module'
>;
export type SymbolKindV1 = Exclude<NodeKind, 'repository' | 'file'>;

export interface FileSummaryV1 {
  readonly id: string;
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  readonly locations?: readonly LocationV1[];
}

export interface SymbolSummaryV1 {
  readonly id: string;
  readonly kind: SymbolKindV1;
  readonly name: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly memberRole: MemberRole;
  readonly locations?: readonly LocationV1[];
}

export type NodeSummaryV1 = FileSummaryV1 | SymbolSummaryV1;

export interface SymbolSelectorV1 {
  readonly kind?: SymbolKindV1;
  readonly name?: string;
  readonly qualifiedName?: string;
  readonly path?: string;
  readonly memberRole?: MemberRole;
  readonly containerId?: string;
}

export interface FunctionSelectorV1 extends Omit<SymbolSelectorV1, 'kind'> {
  readonly kind?: 'function';
}

export interface SearchRequestV1 {
  readonly operation: 'searchSymbols';
  readonly query: string;
  readonly kind?: SearchSymbolKindV1;
  readonly path?: string;
  readonly containerId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly allowPartial?: boolean;
}

export interface GetSymbolRequestV1 {
  readonly operation: 'getSymbol';
  readonly nodeId?: string;
  readonly selector?: SymbolSelectorV1;
  readonly limit?: number;
  readonly cursor?: string;
  readonly allowPartial?: boolean;
}

export interface FileRelationRequestV1 {
  readonly operation: 'listFileDependencies' | 'listFileDependents';
  readonly fileId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly allowPartial?: boolean;
}

export interface CallRelationRequestV1 {
  readonly operation: 'listCallers' | 'listCallees';
  readonly function: FunctionSelectorV1;
  readonly limit?: number;
  readonly cursor?: string;
  readonly allowPartial?: boolean;
}

export type QueryRequestV1 =
  | SearchRequestV1
  | GetSymbolRequestV1
  | FileRelationRequestV1
  | CallRelationRequestV1;

export interface QueryPageV1<T> {
  readonly schemaVersion: 1;
  readonly completeness: 'complete' | 'partial';
  readonly items: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
  readonly continuation?: string;
}

export interface SearchResponseV1 {
  readonly operation: 'searchSymbols';
  readonly page: QueryPageV1<SymbolSummaryV1>;
}

export interface GetSymbolResponseV1 {
  readonly operation: 'getSymbol';
  readonly schemaVersion: 1;
  readonly completeness: 'complete' | 'partial';
  readonly symbol: SymbolSummaryV1;
  readonly container?: FileSummaryV1 | SymbolSummaryV1;
  readonly children: QueryPageV1<SymbolSummaryV1>;
}

export interface FileRelationResponseV1 {
  readonly operation: 'listFileDependencies' | 'listFileDependents';
  readonly page: QueryPageV1<FileSummaryV1>;
}

export interface CallRelationResponseV1 {
  readonly operation: 'listCallers' | 'listCallees';
  readonly page: QueryPageV1<SymbolSummaryV1>;
}

export type QueryResponseV1 =
  | SearchResponseV1
  | GetSymbolResponseV1
  | FileRelationResponseV1
  | CallRelationResponseV1;

export type QueryErrorCodeV1 =
  | 'invalid_request'
  | 'limit_exceeded'
  | 'not_found'
  | 'ambiguous'
  | 'entity_type_mismatch'
  | 'unsupported_schema'
  | 'invalid_snapshot'
  | 'partial_not_allowed'
  | 'internal';

export type ErrorFieldV1 =
  | 'operation'
  | 'query'
  | 'kind'
  | 'path'
  | 'containerId'
  | 'fileId'
  | 'nodeId'
  | 'selector'
  | 'function'
  | 'cursor'
  | 'limit'
  | 'allowPartial'
  | 'root'
  | 'snapshotPath'
  | 'outputPath';

export interface QueryErrorV1 {
  readonly code: QueryErrorCodeV1;
  readonly message: string;
  readonly field?: ErrorFieldV1;
  readonly candidates?: QueryPageV1<NodeSummaryV1>;
  readonly totalCandidates?: number;
}

export interface GraphQueryService {
  searchSymbols(request: SearchRequestV1): QueryResponseV1 | QueryErrorV1;
  getSymbol(request: GetSymbolRequestV1): QueryResponseV1 | QueryErrorV1;
  listFileDependencies(
    request: FileRelationRequestV1,
  ): QueryResponseV1 | QueryErrorV1;
  listFileDependents(
    request: FileRelationRequestV1,
  ): QueryResponseV1 | QueryErrorV1;
  listCallers(request: CallRelationRequestV1): QueryResponseV1 | QueryErrorV1;
  listCallees(request: CallRelationRequestV1): QueryResponseV1 | QueryErrorV1;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_CURSOR_BYTES = 4096;
const NODE_ID = /^n:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const symbolKinds = new Set<SymbolKindV1>([
  'module',
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const searchKinds = new Set<SearchSymbolKindV1>([
  'class',
  'interface',
  'function',
  'variable',
  'type',
  'parameter',
]);
const roles = new Set<MemberRole>(['none', 'static', 'instance']);

const messages: Record<QueryErrorCodeV1, string> = {
  invalid_request: 'The query request is invalid.',
  limit_exceeded: 'The query limit is outside the allowed range.',
  not_found: 'The requested graph item was not found.',
  ambiguous: 'The selector matches multiple graph items.',
  entity_type_mismatch: 'The requested graph item has the wrong type.',
  unsupported_schema: 'The snapshot schema is unsupported.',
  invalid_snapshot: 'The snapshot is invalid.',
  partial_not_allowed:
    'The snapshot is partial and partial results are disabled.',
  internal: 'The operation could not be completed.',
};

type QueryResult = QueryResponseV1 | QueryErrorV1;
type PathKey = readonly [0, string] | readonly [1, ''];
type SearchSortKey = readonly [PathKey, string, string, string];
type ChildSortKey = readonly [string, string, string];
type FileSortKey = readonly [string, string];
type CallSortKey = readonly [string, PathKey, string, string];
type SortKey = SearchSortKey | ChildSortKey | FileSortKey | CallSortKey;

interface CursorEnvelope {
  readonly schemaVersion: 1;
  readonly snapshotDigest: string;
  readonly operation: QueryRequestV1['operation'];
  readonly filterFingerprint: string;
  readonly lastSortKey: SortKey;
}

interface NormalizedBase {
  readonly operation: QueryRequestV1['operation'];
  readonly limit: number;
  readonly allowPartial: boolean;
  readonly cursor: string | undefined;
}

interface NormalizedSearch extends NormalizedBase {
  readonly operation: 'searchSymbols';
  readonly query: string;
  readonly kind?: SearchSymbolKindV1;
  readonly path?: string;
  readonly containerId?: string;
}

interface NormalizedSelector {
  readonly kind?: SymbolKindV1;
  readonly name?: string;
  readonly qualifiedName?: string;
  readonly path?: string;
  readonly memberRole?: MemberRole;
  readonly containerId?: string;
}

interface NormalizedGetSymbol extends NormalizedBase {
  readonly operation: 'getSymbol';
  readonly nodeId?: string;
  readonly selector?: NormalizedSelector;
}

interface NormalizedFileRelation extends NormalizedBase {
  readonly operation: 'listFileDependencies' | 'listFileDependents';
  readonly fileId: string;
}

interface NormalizedCallRelation extends NormalizedBase {
  readonly operation: 'listCallers' | 'listCallees';
  readonly function: NormalizedSelector & { readonly kind: 'function' };
}

interface IndexState {
  readonly snapshotDigest: string;
  readonly completeness: 'complete' | 'partial';
  readonly nodes: ReadonlyMap<string, NodeV1>;
  readonly files: readonly FileNodeV1[];
  readonly symbols: readonly SymbolNodeV1[];
  readonly parentByChild: ReadonlyMap<string, NodeV1>;
  readonly childrenByParent: ReadonlyMap<string, readonly NodeV1[]>;
  readonly fileDependencies: ReadonlyMap<string, readonly string[]>;
  readonly fileDependents: ReadonlyMap<string, readonly string[]>;
  readonly callees: ReadonlyMap<string, readonly string[]>;
  readonly callers: ReadonlyMap<string, readonly string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function ordinal(left: string, right: string): number {
  return Buffer.from(left.normalize('NFC'), 'utf8').compare(
    Buffer.from(right.normalize('NFC'), 'utf8'),
  );
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function compareTuple(
  left: readonly unknown[],
  right: readonly unknown[],
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    let result: number;
    if (Array.isArray(a) && Array.isArray(b)) result = compareTuple(a, b);
    else if (typeof a === 'number' && typeof b === 'number')
      result = compareNumbers(a, b);
    else if (typeof a === 'string' && typeof b === 'string')
      result = ordinal(a, b);
    else result = ordinal(String(a), String(b));
    if (result !== 0) return result;
  }
  return compareNumbers(left.length, right.length);
}

function hasValidSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function nfc(value: unknown): string | undefined {
  if (typeof value !== 'string' || !hasValidSurrogates(value)) return undefined;
  return value.normalize('NFC');
}

function repositoryPath(value: unknown): string | undefined {
  const text = nfc(value);
  if (
    text === undefined ||
    text.length === 0 ||
    text.includes('\\') ||
    text.includes('\0') ||
    text.startsWith('/') ||
    /^[A-Za-z]:/.test(text)
  )
    return undefined;
  const parts = text.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..'))
    return undefined;
  return parts.join('/');
}

function pathKey(path: string | undefined): PathKey {
  return path === undefined ? [1, ''] : [0, path];
}

function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && NODE_ID.test(value);
}

function error(
  code: QueryErrorCodeV1,
  field?: ErrorFieldV1,
  extra?: Pick<QueryErrorV1, 'candidates' | 'totalCandidates'>,
): QueryErrorV1 {
  return {
    code,
    message: messages[code],
    ...(field === undefined ? {} : { field }),
    ...(extra?.candidates === undefined
      ? {}
      : { candidates: extra.candidates }),
    ...(extra?.totalCandidates === undefined
      ? {}
      : { totalCandidates: extra.totalCandidates }),
  };
}

function cloneLocation(location: LocationV1): LocationV1 {
  return {
    path: location.path,
    start: { line: location.start.line, column: location.start.column },
    end: { line: location.end.line, column: location.end.column },
  };
}

function cloneLocations(
  locations: readonly LocationV1[] | undefined,
): readonly LocationV1[] | undefined {
  return locations?.map(cloneLocation);
}

function isFile(node: NodeV1 | undefined): node is FileNodeV1 {
  return node?.kind === 'file';
}

function isSymbol(node: NodeV1 | undefined): node is SymbolNodeV1 {
  return node !== undefined && symbolKinds.has(node.kind as SymbolKindV1);
}

function toSummary(node: NodeV1): NodeSummaryV1 {
  if (node.kind === 'file') {
    const summary: FileSummaryV1 = {
      id: node.id,
      kind: 'file',
      name: node.name,
      path: node.path,
    };
    const locations = cloneLocations(node.locations);
    return locations === undefined ? summary : { ...summary, locations };
  }
  if (node.kind === 'repository')
    throw new Error('Repository nodes are not query summaries.');
  const summary: SymbolSummaryV1 = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    path: node.path,
    qualifiedName: node.qualifiedName,
    memberRole: node.memberRole,
  };
  const locations = cloneLocations(node.locations);
  return locations === undefined ? summary : { ...summary, locations };
}

function searchKey(node: NodeV1): SearchSortKey {
  if (node.kind === 'repository' || node.kind === 'file')
    throw new Error('Invalid search node.');
  return [pathKey(node.path), node.qualifiedName, node.kind, node.id];
}

function childKey(node: NodeV1): ChildSortKey {
  if (node.kind === 'repository' || node.kind === 'file')
    throw new Error('Invalid child node.');
  return [node.kind, node.qualifiedName, node.id];
}

function fileKey(node: NodeV1): FileSortKey {
  if (node.kind !== 'file') throw new Error('Invalid file node.');
  return [node.path, node.id];
}

function callKey(node: NodeV1): CallSortKey {
  if (node.kind === 'repository' || node.kind === 'file')
    throw new Error('Invalid call node.');
  return [node.qualifiedName, pathKey(node.path), node.kind, node.id];
}

function sortNodes<T extends NodeV1>(
  nodes: readonly T[],
  key: (node: T) => SortKey,
): readonly T[] {
  return [...nodes].sort((left, right) => compareTuple(key(left), key(right)));
}

function paginate<T extends NodeV1>(
  nodes: readonly T[],
  limit: number,
  completeness: 'complete' | 'partial',
  key: (node: T) => SortKey,
  cursor: CursorEnvelope | undefined,
  encode: (lastSortKey: SortKey) => string,
): QueryPageV1<NodeSummaryV1> {
  let start = 0;
  if (cursor !== undefined) {
    const position = nodes.findIndex(
      (node) => compareTuple(key(node), cursor.lastSortKey) === 0,
    );
    if (position < 0) throw new InvalidCursorError();
    start = position + 1;
  }
  const items = nodes.slice(start, start + limit).map(toSummary);
  const truncated = start + items.length < nodes.length;
  return {
    schemaVersion: 1,
    completeness,
    items,
    total: nodes.length,
    truncated,
    ...(truncated && items.length > 0
      ? { continuation: encode(key(nodes[start + items.length - 1]!)) }
      : {}),
  };
}

class InvalidCursorError extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string | undefined {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return undefined;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length > MAX_CURSOR_BYTES) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isPathKey(value: unknown): value is PathKey {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    ((value[0] === 0 && typeof value[1] === 'string') ||
      (value[0] === 1 && value[1] === ''))
  );
}

function isSortKey(
  value: unknown,
  operation: QueryRequestV1['operation'],
): value is SortKey {
  if (!Array.isArray(value)) return false;
  if (operation === 'searchSymbols')
    return (
      value.length === 4 &&
      isPathKey(value[0]) &&
      value.slice(1).every((item) => typeof item === 'string')
    );
  if (operation === 'getSymbol')
    return (
      value.length === 3 && value.every((item) => typeof item === 'string')
    );
  if (
    operation === 'listFileDependencies' ||
    operation === 'listFileDependents'
  )
    return (
      value.length === 2 && value.every((item) => typeof item === 'string')
    );
  return (
    value.length === 4 &&
    typeof value[0] === 'string' &&
    isPathKey(value[1]) &&
    value.slice(2).every((item) => typeof item === 'string')
  );
}

function cursorText(
  snapshotDigestValue: string,
  operation: QueryRequestV1['operation'],
  filterFingerprint: string,
  lastSortKey: SortKey,
): string {
  const envelope: CursorEnvelope = {
    schemaVersion: 1,
    snapshotDigest: snapshotDigestValue,
    operation,
    filterFingerprint,
    lastSortKey,
  };
  return base64Url(JSON.stringify(envelope));
}

function parseCursor(
  value: unknown,
  snapshotDigestValue: string,
  operation: QueryRequestV1['operation'],
  filterFingerprint: string,
): CursorEnvelope | undefined {
  if (typeof value !== 'string') return undefined;
  const decoded = decodeBase64Url(value);
  if (decoded === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!isRecord(parsed)) return undefined;
    const keys = Object.keys(parsed);
    if (
      keys.join('\0') !==
      [
        'schemaVersion',
        'snapshotDigest',
        'operation',
        'filterFingerprint',
        'lastSortKey',
      ].join('\0')
    )
      return undefined;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.snapshotDigest !== 'string' ||
      !SHA256.test(parsed.snapshotDigest) ||
      parsed.snapshotDigest !== snapshotDigestValue ||
      parsed.operation !== operation ||
      parsed.filterFingerprint !== filterFingerprint ||
      typeof parsed.filterFingerprint !== 'string' ||
      !SHA256.test(parsed.filterFingerprint) ||
      !isSortKey(parsed.lastSortKey, operation)
    )
      return undefined;
    return parsed as unknown as CursorEnvelope;
  } catch {
    return undefined;
  }
}

function selectorObject(
  value: unknown,
  functionSelector: boolean,
): NormalizedSelector | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = [
    'kind',
    'name',
    'qualifiedName',
    'path',
    'memberRole',
    'containerId',
  ];
  if (!hasOnlyKeys(value, allowed)) return undefined;
  const fields = Object.keys(value);
  if (fields.length === 0) return undefined;
  if (fields.some((field) => value[field] === undefined)) return undefined;
  const kind = value.kind;
  if (
    kind !== undefined &&
    (typeof kind !== 'string' || !symbolKinds.has(kind as SymbolKindV1))
  )
    return undefined;
  if (functionSelector && kind !== undefined && kind !== 'function')
    return undefined;
  const name = value.name === undefined ? undefined : nfc(value.name);
  const qualifiedName =
    value.qualifiedName === undefined ? undefined : nfc(value.qualifiedName);
  const path =
    value.path === undefined ? undefined : repositoryPath(value.path);
  const memberRole = value.memberRole;
  const containerId =
    value.containerId === undefined ? undefined : value.containerId;
  if (value.name !== undefined && name === undefined) return undefined;
  if (value.qualifiedName !== undefined && qualifiedName === undefined)
    return undefined;
  if (value.path !== undefined && path === undefined) return undefined;
  if (
    memberRole !== undefined &&
    (typeof memberRole !== 'string' || !roles.has(memberRole as MemberRole))
  )
    return undefined;
  if (containerId !== undefined && !isNodeId(containerId)) return undefined;
  return {
    ...(kind === undefined ? {} : { kind: kind as SymbolKindV1 }),
    ...(name === undefined ? {} : { name }),
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(path === undefined ? {} : { path }),
    ...(memberRole === undefined
      ? {}
      : { memberRole: memberRole as MemberRole }),
    ...(containerId === undefined ? {} : { containerId }),
  };
}

function selectorFingerprint(
  selector: NormalizedSelector,
): Record<string, unknown> {
  return {
    ...(selector.kind === undefined ? {} : { kind: selector.kind }),
    ...(selector.name === undefined ? {} : { name: selector.name }),
    ...(selector.qualifiedName === undefined
      ? {}
      : { qualifiedName: selector.qualifiedName }),
    ...(selector.path === undefined ? {} : { path: selector.path }),
    ...(selector.memberRole === undefined
      ? {}
      : { memberRole: selector.memberRole }),
    ...(selector.containerId === undefined
      ? {}
      : { containerId: selector.containerId }),
  };
}

function normalizedLimit(value: unknown):
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false;
      readonly code: 'invalid_request' | 'limit_exceeded';
    } {
  if (value === undefined) return { ok: true, value: DEFAULT_LIMIT };
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    return { ok: false, code: 'invalid_request' };
  if (value < 1 || value > MAX_LIMIT)
    return { ok: false, code: 'limit_exceeded' };
  return { ok: true, value };
}

function baseFields(
  value: Record<string, unknown>,
  operation: QueryRequestV1['operation'],
): { readonly base?: NormalizedBase; readonly error?: QueryErrorV1 } {
  const limit = normalizedLimit(value.limit);
  if (!limit.ok) return { error: error(limit.code, 'limit') };
  if (
    value.allowPartial !== undefined &&
    typeof value.allowPartial !== 'boolean'
  )
    return { error: error('invalid_request', 'allowPartial') };
  if (value.cursor !== undefined && typeof value.cursor !== 'string')
    return { error: error('invalid_request', 'cursor') };
  return {
    base: {
      operation,
      limit: limit.value,
      allowPartial: value.allowPartial ?? false,
      cursor: value.cursor as string | undefined,
    },
  };
}

function normalizeSearch(
  value: unknown,
):
  | { readonly normalized: NormalizedSearch; readonly error?: undefined }
  | { readonly normalized?: undefined; readonly error: QueryErrorV1 } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'operation',
      'query',
      'kind',
      'path',
      'containerId',
      'limit',
      'cursor',
      'allowPartial',
    ])
  )
    return { error: error('invalid_request') };
  if (value.operation !== 'searchSymbols')
    return { error: error('invalid_request', 'operation') };
  const base = baseFields(value, 'searchSymbols');
  if (base.error || !base.base) return { error: base.error! };
  const queryValue = nfc(value.query);
  if (queryValue === undefined)
    return { error: error('invalid_request', 'query') };
  const query = queryValue.trim().normalize('NFC');
  if (query.length < 1 || query.length > 256)
    return { error: error('invalid_request', 'query') };
  const kind = value.kind;
  if (
    kind !== undefined &&
    (typeof kind !== 'string' || !searchKinds.has(kind as SearchSymbolKindV1))
  )
    return { error: error('invalid_request', 'kind') };
  const path =
    value.path === undefined ? undefined : repositoryPath(value.path);
  if (value.path !== undefined && path === undefined)
    return { error: error('invalid_request', 'path') };
  const containerId =
    value.containerId === undefined ? undefined : value.containerId;
  if (containerId !== undefined && !isNodeId(containerId))
    return { error: error('invalid_request', 'containerId') };
  return {
    normalized: {
      ...base.base,
      operation: 'searchSymbols',
      query,
      ...(kind === undefined ? {} : { kind: kind as SearchSymbolKindV1 }),
      ...(path === undefined ? {} : { path }),
      ...(containerId === undefined ? {} : { containerId }),
    },
  };
}

function normalizeGetSymbol(
  value: unknown,
):
  | { readonly normalized: NormalizedGetSymbol; readonly error?: undefined }
  | { readonly normalized?: undefined; readonly error: QueryErrorV1 } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'operation',
      'nodeId',
      'selector',
      'limit',
      'cursor',
      'allowPartial',
    ])
  )
    return { error: error('invalid_request') };
  if (value.operation !== 'getSymbol')
    return { error: error('invalid_request', 'operation') };
  const base = baseFields(value, 'getSymbol');
  if (base.error || !base.base) return { error: base.error! };
  const hasNodeId = value.nodeId !== undefined;
  const hasSelector = value.selector !== undefined;
  if (hasNodeId === hasSelector || (hasNodeId && !isNodeId(value.nodeId)))
    return {
      error: error('invalid_request', hasNodeId ? 'nodeId' : 'selector'),
    };
  if (hasNodeId)
    return {
      normalized: {
        ...base.base,
        operation: 'getSymbol',
        nodeId: value.nodeId as string,
      },
    };
  const selector = selectorObject(value.selector, false);
  if (selector === undefined)
    return { error: error('invalid_request', 'selector') };
  return { normalized: { ...base.base, operation: 'getSymbol', selector } };
}

function normalizeFileRelation(
  value: unknown,
  operation: FileRelationRequestV1['operation'],
):
  | { readonly normalized: NormalizedFileRelation; readonly error?: undefined }
  | { readonly normalized?: undefined; readonly error: QueryErrorV1 } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'operation',
      'fileId',
      'limit',
      'cursor',
      'allowPartial',
    ])
  )
    return { error: error('invalid_request') };
  if (value.operation !== operation)
    return { error: error('invalid_request', 'operation') };
  const base = baseFields(value, operation);
  if (base.error || !base.base) return { error: base.error! };
  if (!isNodeId(value.fileId))
    return { error: error('invalid_request', 'fileId') };
  return { normalized: { ...base.base, operation, fileId: value.fileId } };
}

function normalizeCallRelation(
  value: unknown,
  operation: CallRelationRequestV1['operation'],
):
  | { readonly normalized: NormalizedCallRelation; readonly error?: undefined }
  | { readonly normalized?: undefined; readonly error: QueryErrorV1 } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'operation',
      'function',
      'limit',
      'cursor',
      'allowPartial',
    ])
  )
    return { error: error('invalid_request') };
  if (value.operation !== operation)
    return { error: error('invalid_request', 'operation') };
  const base = baseFields(value, operation);
  if (base.error || !base.base) return { error: base.error! };
  const selector = selectorObject(value.function, true);
  if (selector === undefined)
    return { error: error('invalid_request', 'function') };
  return {
    normalized: {
      ...base.base,
      operation,
      function: { ...selector, kind: 'function' },
    },
  };
}

function filterObject(
  normalized:
    | NormalizedSearch
    | NormalizedGetSymbol
    | NormalizedFileRelation
    | NormalizedCallRelation,
): Record<string, unknown> {
  const allowPartial = normalized.allowPartial;
  if (normalized.operation === 'searchSymbols')
    return {
      operation: normalized.operation,
      query: normalized.query,
      ...(normalized.kind === undefined ? {} : { kind: normalized.kind }),
      ...(normalized.path === undefined ? {} : { path: normalized.path }),
      ...(normalized.containerId === undefined
        ? {}
        : { containerId: normalized.containerId }),
      allowPartial,
    };
  if (normalized.operation === 'getSymbol')
    return {
      operation: normalized.operation,
      ...(normalized.nodeId === undefined ? {} : { nodeId: normalized.nodeId }),
      ...(normalized.selector === undefined
        ? {}
        : { selector: selectorFingerprint(normalized.selector) }),
      allowPartial,
    };
  if (
    normalized.operation === 'listFileDependencies' ||
    normalized.operation === 'listFileDependents'
  )
    return {
      operation: normalized.operation,
      fileId: normalized.fileId,
      allowPartial,
    };
  if (
    normalized.operation !== 'listCallers' &&
    normalized.operation !== 'listCallees'
  )
    throw new Error('Invalid query operation.');
  return {
    operation: normalized.operation,
    function: selectorFingerprint(normalized.function),
    allowPartial,
  };
}

function fingerprint(
  normalized:
    | NormalizedSearch
    | NormalizedGetSymbol
    | NormalizedFileRelation
    | NormalizedCallRelation,
): string {
  return sha256(JSON.stringify(filterObject(normalized)));
}

function repositoryOwner(
  nodeId: string,
  parentByChild: ReadonlyMap<string, NodeV1>,
): string | undefined {
  const visited = new Set<string>();
  let current: NodeV1 | undefined = parentByChild.get(nodeId);
  while (current !== undefined && !visited.has(current.id)) {
    if (current.kind === 'file') return current.id;
    visited.add(current.id);
    current = parentByChild.get(current.id);
  }
  return undefined;
}

function buildState(snapshot: SnapshotV1): IndexState {
  if (snapshot.schemaVersion !== 1) throw new UnsupportedSchemaError();
  if (
    (snapshot.completeness !== 'complete' &&
      snapshot.completeness !== 'partial') ||
    !Array.isArray(snapshot.nodes) ||
    !Array.isArray(snapshot.edges) ||
    !Array.isArray(snapshot.diagnostics)
  )
    throw new InvalidSnapshotError();
  const snapshotDigestValue = snapshotDigest(snapshot);
  const nodes = new Map<string, NodeV1>();
  for (const node of snapshot.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || nodes.has(node.id))
      throw new InvalidSnapshotError();
    nodes.set(node.id, structuredClone(node) as unknown as NodeV1);
  }
  const parent = new Map<string, NodeV1>();
  const children = new Map<string, NodeV1[]>();
  for (const edge of snapshot.edges) {
    const typedEdge = edge as EdgeV1;
    if (!nodes.has(typedEdge.from) || !nodes.has(typedEdge.to))
      throw new InvalidSnapshotError();
    if (typedEdge.kind === 'contains') {
      if (parent.has(typedEdge.to)) throw new InvalidSnapshotError();
      const from = nodes.get(typedEdge.from)!;
      parent.set(typedEdge.to, from);
      const list = children.get(typedEdge.from) ?? [];
      list.push(nodes.get(typedEdge.to)!);
      children.set(typedEdge.from, list);
    }
  }
  for (const list of children.values())
    list.sort((a, b) => ordinal(a.kind, b.kind) || ordinal(a.id, b.id));
  const fileDependencies = new Map<string, Set<string>>();
  const fileDependents = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  const callers = new Map<string, Set<string>>();
  const addRelation = (
    map: Map<string, Set<string>>,
    from: string,
    to: string,
  ) => {
    const list = map.get(from) ?? new Set<string>();
    list.add(to);
    map.set(from, list);
  };
  for (const edge of snapshot.edges as readonly EdgeV1[]) {
    if (edge.kind === 'imports' || edge.kind === 'exports') {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      const fromFile =
        from?.kind === 'module' ? repositoryOwner(from.id, parent) : undefined;
      const toFile =
        to?.kind === 'module' ? repositoryOwner(to.id, parent) : undefined;
      if (fromFile !== undefined && toFile !== undefined) {
        addRelation(fileDependencies, fromFile, toFile);
        addRelation(fileDependents, toFile, fromFile);
      }
    } else if (edge.kind === 'calls') {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (from?.kind === 'function' && to?.kind === 'function') {
        addRelation(callees, from.id, to.id);
        addRelation(callers, to.id, from.id);
      }
    }
  }
  const sortRelationMap = (
    map: Map<string, Set<string>>,
    key: (node: NodeV1) => SortKey,
  ): ReadonlyMap<string, readonly string[]> => {
    const result = new Map<string, readonly string[]>();
    for (const [source, ids] of map) {
      const values = [...ids]
        .map((id) => nodes.get(id))
        .filter((node): node is NodeV1 => node !== undefined);
      values.sort((a, b) => compareTuple(key(a), key(b)));
      result.set(
        source,
        values.map((node) => node.id),
      );
    }
    return result;
  };
  const sortedNodes = [...nodes.values()];
  const files = sortedNodes
    .filter(isFile)
    .sort((a, b) => compareTuple(fileKey(a), fileKey(b)));
  const symbols = sortedNodes
    .filter(isSymbol)
    .sort((a, b) => compareTuple(searchKey(a), searchKey(b)));
  return {
    snapshotDigest: snapshotDigestValue,
    completeness: snapshot.completeness,
    nodes,
    files,
    symbols,
    parentByChild: parent,
    childrenByParent: children,
    fileDependencies: sortRelationMap(fileDependencies, fileKey),
    fileDependents: sortRelationMap(fileDependents, fileKey),
    callees: sortRelationMap(callees, callKey),
    callers: sortRelationMap(callers, callKey),
  };
}

class UnsupportedSchemaError extends Error {}
class InvalidSnapshotError extends Error {}

function normalizeError(errorValue: unknown): QueryErrorV1 {
  return errorValue instanceof UnsupportedSchemaError
    ? error('unsupported_schema')
    : error('invalid_snapshot');
}

export function createGraphQueryService(
  snapshot: SnapshotV1,
): GraphQueryService {
  let state: IndexState | undefined;
  let stateError: QueryErrorV1 | undefined;
  try {
    state = buildState(snapshot);
  } catch (errorValue) {
    stateError = normalizeError(errorValue);
  }

  const checkState = (normalized: NormalizedBase): QueryErrorV1 | undefined => {
    if (stateError) return stateError;
    if (!state) return error('internal');
    if (state.completeness === 'partial' && !normalized.allowPartial)
      return error('partial_not_allowed', 'allowPartial');
    return undefined;
  };

  const parseAndCheckCursor = (
    normalized:
      | NormalizedSearch
      | NormalizedGetSymbol
      | NormalizedFileRelation
      | NormalizedCallRelation,
  ): CursorEnvelope | QueryErrorV1 | undefined => {
    const value = normalized.cursor;
    if (value === undefined) return undefined;
    const parsed = parseCursor(
      value,
      state?.snapshotDigest ?? '',
      normalized.operation,
      fingerprint(normalized),
    );
    return parsed ?? error('invalid_request', 'cursor');
  };

  const searchSymbols = (request: SearchRequestV1): QueryResult => {
    try {
      const result = normalizeSearch(request);
      if (result.error) return result.error;
      const normalized = result.normalized;
      const stateProblem = checkState(normalized);
      if (stateProblem) return stateProblem;
      const cursor = parseAndCheckCursor(normalized);
      if (cursor && 'code' in cursor) return cursor;
      const matches = sortNodes(
        state!.symbols.filter((node) => {
          if (normalized.kind !== undefined && node.kind !== normalized.kind)
            return false;
          if (normalized.path !== undefined && node.path !== normalized.path)
            return false;
          if (
            normalized.containerId !== undefined &&
            state!.parentByChild.get(node.id)?.id !== normalized.containerId
          )
            return false;
          return (
            node.name.includes(normalized.query) ||
            node.qualifiedName.includes(normalized.query)
          );
        }),
        searchKey,
      );
      const page = paginate(
        matches,
        normalized.limit,
        state!.completeness,
        searchKey,
        cursor as CursorEnvelope | undefined,
        (lastSortKey) =>
          cursorText(
            state!.snapshotDigest,
            normalized.operation,
            fingerprint(normalized),
            lastSortKey,
          ),
      );
      return {
        operation: 'searchSymbols',
        page: page as QueryPageV1<SymbolSummaryV1>,
      };
    } catch (errorValue) {
      return errorValue instanceof InvalidCursorError
        ? error('invalid_request', 'cursor')
        : error('internal');
    }
  };

  const getSymbol = (request: GetSymbolRequestV1): QueryResult => {
    try {
      const result = normalizeGetSymbol(request);
      if (result.error) return result.error;
      const normalized = result.normalized;
      const stateProblem = checkState(normalized);
      if (stateProblem) return stateProblem;
      const cursor = parseAndCheckCursor(normalized);
      if (cursor && 'code' in cursor) return cursor;
      let matches: readonly NodeV1[];
      if (normalized.nodeId !== undefined) {
        const node = state!.nodes.get(normalized.nodeId);
        if (node === undefined) return error('not_found', 'nodeId');
        if (!isSymbol(node)) return error('entity_type_mismatch', 'nodeId');
        matches = [node];
      } else {
        const selector = normalized.selector!;
        matches = state!.symbols.filter((node) => {
          if (selector.kind !== undefined && node.kind !== selector.kind)
            return false;
          if (selector.name !== undefined && node.name !== selector.name)
            return false;
          if (
            selector.qualifiedName !== undefined &&
            node.qualifiedName !== selector.qualifiedName
          )
            return false;
          if (selector.path !== undefined && node.path !== selector.path)
            return false;
          if (
            selector.memberRole !== undefined &&
            node.memberRole !== selector.memberRole
          )
            return false;
          return (
            selector.containerId === undefined ||
            state!.parentByChild.get(node.id)?.id === selector.containerId
          );
        });
      }
      const sortedMatches = sortNodes(matches, searchKey);
      if (sortedMatches.length === 0)
        return error('not_found', normalized.nodeId ? 'nodeId' : 'selector');
      if (sortedMatches.length > 1) {
        const candidates = paginate(
          sortedMatches,
          normalized.limit,
          state!.completeness,
          searchKey,
          cursor as CursorEnvelope | undefined,
          (lastSortKey) =>
            cursorText(
              state!.snapshotDigest,
              normalized.operation,
              fingerprint(normalized),
              lastSortKey,
            ),
        );
        return error('ambiguous', 'selector', {
          candidates,
          totalCandidates: sortedMatches.length,
        });
      }
      const symbol = sortedMatches[0]!;
      const parent = state!.parentByChild.get(symbol.id);
      const children = sortNodes(
        (state!.childrenByParent.get(symbol.id) ?? []).filter(isSymbol),
        childKey,
      );
      const childrenPage = paginate(
        children,
        normalized.limit,
        state!.completeness,
        childKey,
        cursor as CursorEnvelope | undefined,
        (lastSortKey) =>
          cursorText(
            state!.snapshotDigest,
            normalized.operation,
            fingerprint(normalized),
            lastSortKey,
          ),
      );
      return {
        operation: 'getSymbol',
        schemaVersion: 1,
        completeness: state!.completeness,
        symbol: toSummary(symbol) as SymbolSummaryV1,
        ...(parent && (isFile(parent) || isSymbol(parent))
          ? { container: toSummary(parent) }
          : {}),
        children: childrenPage as QueryPageV1<SymbolSummaryV1>,
      };
    } catch (errorValue) {
      return errorValue instanceof InvalidCursorError
        ? error('invalid_request', 'cursor')
        : error('internal');
    }
  };

  const relation = (
    request: FileRelationRequestV1,
    operation: FileRelationRequestV1['operation'],
  ): QueryResult => {
    try {
      const result = normalizeFileRelation(request, operation);
      if (result.error) return result.error;
      const normalized = result.normalized;
      const stateProblem = checkState(normalized);
      if (stateProblem) return stateProblem;
      const cursor = parseAndCheckCursor(normalized);
      if (cursor && 'code' in cursor) return cursor;
      const source = state!.nodes.get(normalized.fileId);
      if (source === undefined) return error('not_found', 'fileId');
      if (!isFile(source)) return error('entity_type_mismatch', 'fileId');
      const ids =
        (operation === 'listFileDependencies'
          ? state!.fileDependencies.get(source.id)
          : state!.fileDependents.get(source.id)) ?? [];
      const nodes = ids
        .map((id) => state!.nodes.get(id))
        .filter((node): node is Extract<NodeV1, { kind: 'file' }> =>
          isFile(node),
        );
      const page = paginate(
        nodes,
        normalized.limit,
        state!.completeness,
        fileKey,
        cursor as CursorEnvelope | undefined,
        (lastSortKey) =>
          cursorText(
            state!.snapshotDigest,
            normalized.operation,
            fingerprint(normalized),
            lastSortKey,
          ),
      );
      return { operation, page: page as QueryPageV1<FileSummaryV1> };
    } catch (errorValue) {
      return errorValue instanceof InvalidCursorError
        ? error('invalid_request', 'cursor')
        : error('internal');
    }
  };

  const callRelation = (
    request: CallRelationRequestV1,
    operation: CallRelationRequestV1['operation'],
  ): QueryResult => {
    try {
      const result = normalizeCallRelation(request, operation);
      if (result.error) return result.error;
      const normalized = result.normalized;
      const stateProblem = checkState(normalized);
      if (stateProblem) return stateProblem;
      const cursor = parseAndCheckCursor(normalized);
      if (cursor && 'code' in cursor) return cursor;
      const selector = normalized.function;
      const matches = sortNodes(
        state!.symbols.filter((node) => {
          if (node.kind !== 'function') return false;
          if (selector.name !== undefined && node.name !== selector.name)
            return false;
          if (
            selector.qualifiedName !== undefined &&
            node.qualifiedName !== selector.qualifiedName
          )
            return false;
          if (selector.path !== undefined && node.path !== selector.path)
            return false;
          if (
            selector.memberRole !== undefined &&
            node.memberRole !== selector.memberRole
          )
            return false;
          return (
            selector.containerId === undefined ||
            state!.parentByChild.get(node.id)?.id === selector.containerId
          );
        }),
        searchKey,
      );
      if (matches.length === 0) return error('not_found', 'function');
      if (matches.length > 1) {
        const candidates = paginate(
          matches,
          normalized.limit,
          state!.completeness,
          searchKey,
          cursor as CursorEnvelope | undefined,
          (lastSortKey) =>
            cursorText(
              state!.snapshotDigest,
              normalized.operation,
              fingerprint(normalized),
              lastSortKey,
            ),
        );
        return error('ambiguous', 'function', {
          candidates,
          totalCandidates: matches.length,
        });
      }
      const source = matches[0]!;
      const ids =
        (operation === 'listCallers'
          ? state!.callers.get(source.id)
          : state!.callees.get(source.id)) ?? [];
      const nodes = ids
        .map((id) => state!.nodes.get(id))
        .filter((node): node is NodeV1 => isSymbol(node));
      const sorted = sortNodes(nodes, callKey);
      const page = paginate(
        sorted,
        normalized.limit,
        state!.completeness,
        callKey,
        cursor as CursorEnvelope | undefined,
        (lastSortKey) =>
          cursorText(
            state!.snapshotDigest,
            normalized.operation,
            fingerprint(normalized),
            lastSortKey,
          ),
      );
      return { operation, page: page as QueryPageV1<SymbolSummaryV1> };
    } catch (errorValue) {
      return errorValue instanceof InvalidCursorError
        ? error('invalid_request', 'cursor')
        : error('internal');
    }
  };

  return {
    searchSymbols,
    getSymbol,
    listFileDependencies: (request) =>
      relation(request, 'listFileDependencies'),
    listFileDependents: (request) => relation(request, 'listFileDependents'),
    listCallers: (request) => callRelation(request, 'listCallers'),
    listCallees: (request) => callRelation(request, 'listCallees'),
  };
}
