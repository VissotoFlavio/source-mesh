export const SOURCE_MESH_NAME = 'SourceMesh';

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
