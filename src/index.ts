export const SOURCE_MESH_NAME = 'SourceMesh';

export { extractDeclarationGraph } from './extractor.js';
export {
  digest,
  edgeId,
  fileId,
  frame,
  nodeId,
  repositoryId,
} from './graph.js';
export type {
  DeclarationGraph,
  DiagnosticV1,
  EdgeKindV1,
  GraphDiagnosticCode,
  EdgeV1,
  FileNodeV1,
  LocationV1,
  MemberRole,
  NodeKind,
  NodeV1,
  PositionV1,
  RepositoryNodeV1,
  SymbolNodeV1,
} from './graph.js';
export type {
  ExtractDeclarationGraphRequest,
  ExtractorIdentity,
} from './extractor.js';

export { discoverSourceFiles } from './discovery.js';
export type {
  DiscoverSourceFilesOptions,
  DiscoveryDiagnostic,
  DiscoveryDirent,
  DiscoveryFileSystem,
  DiscoveryLimitReason,
  DiscoveryPathReason,
  DiscoveryResult,
  DiscoveryStats,
} from './discovery.js';
export {
  loadProject,
  PROJECT_LOADER_FALLBACK_OPTIONS,
  PROJECT_ROOT_EXTENSIONS,
} from './project-loader.js';

export {
  decode,
  decodeSnapshot,
  encode,
  encodeSnapshot,
  snapshotDigest,
} from './snapshot/codec.js';
export { DEFAULT_SNAPSHOT_PATH, resolveSnapshotPath } from './snapshot/path.js';
export { openValidatedSnapshot } from './snapshot/bootstrap.js';
export { writeSnapshot } from './snapshot/writer.js';
export { SnapshotError } from './snapshot/types.js';
export type {
  SnapshotCompleteness,
  SnapshotLoadRequest,
  SnapshotV1,
  SnapshotWriteMode,
  SnapshotWriteRequest,
  SnapshotWriteResult,
} from './snapshot/types.js';
export type {
  CompilerDiagnosticPhase,
  DiagnosticLocation,
  DiagnosticSeverity,
  LoadProjectRequest,
  LoadProjectResult,
  LoadedProject,
  ProjectLoaderDiagnostic,
  ProjectRootExtension,
} from './project-loader.js';

export { createGraphQueryService } from './query.js';
export type {
  CallRelationRequestV1,
  CallRelationResponseV1,
  ErrorFieldV1,
  FileRelationRequestV1,
  FileRelationResponseV1,
  FileSummaryV1,
  FunctionSelectorV1,
  GetSymbolRequestV1,
  GetSymbolResponseV1,
  GraphQueryService,
  NodeSummaryV1,
  QueryErrorCodeV1,
  QueryErrorV1,
  QueryPageV1,
  QueryRequestV1,
  QueryResponseV1,
  SearchRequestV1,
  SearchResponseV1,
  SearchSymbolKindV1,
  SymbolKindV1,
  SymbolSelectorV1,
  SymbolSummaryV1,
} from './query.js';

export { createMcpServer } from './mcp/server.js';
export {
  MCP_MAX_MESSAGE_BYTES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOL_NAMES,
  READ_ONLY_ANNOTATIONS,
} from './mcp/contracts.js';
