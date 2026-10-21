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
export type { ExtractDeclarationGraphRequest } from './extractor.js';

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
