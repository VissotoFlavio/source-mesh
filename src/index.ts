export const SOURCE_MESH_NAME = 'SourceMesh';

export {
  LANGUAGE_PACK_CONTRACT_VERSION,
  LanguagePackRegistry,
  validateLanguagePackManifest,
} from './packs.js';
export type {
  AnalysisLimits,
  AnalysisRequest,
  ApprovedFile,
  GraphFragment,
  LanguagePack,
  LanguagePackCapability,
  LanguagePackExecutionMode,
  LanguagePackManifest,
  PackAnalysisResult,
  PackBoundaryDiagnostic,
  PackDiagnostic,
  PackDiagnosticCode,
  PackEdge,
  PackNode,
  RelationConfidence,
} from './packs.js';

export { extractDeclarationGraph } from './extractor.js';
export {
  digest,
  edgeId,
  edgeIdV2,
  fileId,
  fileIdV2,
  frame,
  nodeId,
  nodeIdV2,
  repositoryId,
  repositoryIdV2,
} from './graph.js';
export type {
  DeclarationGraph,
  DeclarationGraphV2,
  DiagnosticV1,
  DiagnosticV2,
  EdgeKindV1,
  EdgeKindV2,
  GraphDiagnosticCode,
  EdgeV1,
  EdgeV2,
  FileNodeV1,
  FileNodeV2,
  LocationV1,
  MemberRole,
  NodeKind,
  NodeKindV2,
  NodeV1,
  NodeV2,
  PositionV1,
  RepositoryNodeV1,
  RepositoryNodeV2,
  SymbolNodeV1,
  SymbolNodeV2,
  V2ContainerNode,
} from './graph.js';
export type {
  ExtractDeclarationGraphRequest,
  ExtractorIdentity,
} from './extractor.js';

export {
  createDefaultDiscoveryFileSystem,
  discoverSourceFiles,
  isContainedPath,
  isRemoteRoot,
  isWindowsUnsafePath,
  normalizeRelativePath,
  isSerializedPathTooLong,
  MAX_DIRECTORY_ENTRIES,
  pathDepth,
  pathIdentityKey,
  readFileBounded,
  resolveRepositoryPath,
  toRepositoryPath,
} from './discovery.js';
export type {
  DiscoverSourceFilesOptions,
  DiscoveryDirectory,
  DiscoveryDiagnostic,
  DiscoveryDirent,
  DiscoveryFileSystem,
  DiscoveryLimitReason,
  DiscoveryPathReason,
  DiscoveryResult,
  DiscoveryStats,
} from './discovery.js';
export {
  discoverCSharpExplicitProjectManifest,
  discoverCSharpManifest,
  discoverCSharpProjectManifest,
} from './csharp/discovery.js';
export {
  createCSharpExplicitProjectSelection,
  CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
} from './csharp/contracts.js';
export type {
  CSharpExplicitProjectSelection,
  CSharpExplicitProjectSelectionDiagnostic,
  CSharpExplicitProjectSelectionDiagnosticCode,
  CSharpExplicitProjectSelectionResult,
  CSharpDiscoveryDiagnostic,
  CSharpDiscoverySelection,
  CSharpExplicitProjectManifest,
  CSharpExplicitProjectManifestResult,
  CSharpManifest,
  CSharpManifestResult,
  CSharpProjectManifest,
  CSharpSelectionKind,
  CSharpSolutionManifest,
  DiscoverCSharpManifestOptions,
} from './csharp/contracts.js';
export {
  analyzeCSharpManifest,
  CSHARP_WORKER_MAX_REQUEST_BYTES,
  CSHARP_WORKER_MAX_RESPONSE_BYTES,
  CSHARP_WORKER_MAX_TIMEOUT_MS,
  CSharpWorkerError,
} from './csharp/worker.js';
export type {
  CSharpSourceEncoding,
  CSharpWorkerOptions,
  CSharpWorkerDiagnostic,
  CSharpWorkerProjectResult,
  CSharpWorkerResult,
} from './csharp/worker.js';
export type {
  CSharpWorkerDeclaration,
  CSharpWorkerLocation,
  CSharpWorkerMemberRole,
  CSharpWorkerNodeKind,
  CSharpWorkerPosition,
  CSharpWorkerRelationship,
  CSharpWorkerRelationshipKind,
  CSharpWorkerRelationshipStatus,
  CSharpWorkerSymbol,
} from './csharp/contracts.js';
export {
  extractCSharpDeclarationGraph,
  extractCSharpGraph,
} from './csharp/extractor.js';
export type { ExtractCSharpDeclarationGraphRequest } from './csharp/extractor.js';
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
export {
  SNAPSHOT_DIRECTORY,
  isReadableSnapshotPath,
  isVersionedSnapshotPath,
  resolveSnapshotPath,
  snapshotPathForId,
} from './snapshot/path.js';
export { openValidatedSnapshot } from './snapshot/bootstrap.js';
export { writeSnapshot } from './snapshot/writer.js';
export { SnapshotError } from './snapshot/types.js';
export type {
  SnapshotCompleteness,
  SnapshotLoadRequest,
  Snapshot,
  SnapshotV1,
  SnapshotV2,
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
  CallRelationResponseV2,
  ErrorFieldV1,
  FileRelationRequestV1,
  FileRelationResponseV1,
  FileRelationResponseV2,
  FileSummaryV1,
  FunctionSelectorV1,
  GetSymbolRequestV1,
  GetSymbolRequestV2,
  GetSymbolResponseV1,
  GetSymbolResponseV2,
  GraphQueryService,
  GraphQueryServiceV2,
  NodeSummaryV1,
  NodeSummaryV2,
  QueryErrorCodeV1,
  QueryErrorV1,
  QueryPageV1,
  QueryRequestV1,
  QueryResponseV1,
  QueryResponseV2,
  SearchRequestV1,
  SearchRequestV2,
  SearchResponseV1,
  SearchResponseV2,
  SearchSymbolKindV1,
  SymbolKindV1,
  SymbolSelectorV1,
  SymbolSelectorV2,
  SymbolSummaryV1,
  SymbolSummaryV2,
  QueryErrorV2,
  QueryPageV2,
  SearchSymbolKindV2,
  SymbolKindV2,
} from './query.js';

export { createMcpServer } from './mcp/server.js';
export {
  MCP_FRAME_OVERHEAD_BYTES,
  MCP_MAX_MESSAGE_BYTES,
  MCP_MAX_REQUEST_BYTES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOL_NAMES,
  READ_ONLY_ANNOTATIONS,
} from './mcp/contracts.js';
