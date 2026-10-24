import type { DiscoveryFileSystem } from '../discovery.js';

export const CSHARP_MAX_SOLUTION_PROJECTS = 256;
export const CSHARP_MAX_PROJECTS = 256;
export const CSHARP_MAX_PROJECT_REFERENCES = 256;
export const CSHARP_MAX_PROJECT_FILES = 10_000;
export const CSHARP_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const CSHARP_MAX_XML_BYTES = 4 * 1024 * 1024;
/** Structural XML caps bound parser amplification below the serialized byte cap. */
export const CSHARP_MAX_XML_DEPTH = 128;
export const CSHARP_MAX_XML_NODES = 4096;
export const CSHARP_MAX_XML_ATTRIBUTES_PER_NODE = 64;
export const CSHARP_MAX_XML_TEXT_ATTRIBUTE_BYTES = 2 * 1024 * 1024;
export const CSHARP_MAX_AGGREGATE_XML_BYTES = 64 * 1024 * 1024;
export const CSHARP_MAX_EXPLICIT_COMPILE_ITEMS = 4096;
export const CSHARP_MAX_EXPLICIT_INCLUDE_READS = 2048;
export const CSHARP_MAX_EXPLICIT_OPERATIONS = 8192;
export const CSHARP_MAX_AGGREGATE_READ_BYTES = 256 * 1024 * 1024;
export const CSHARP_MAX_READ_OPERATIONS = 16_384;

export type CSharpSelectionKind = 'solution' | 'project';

export interface CSharpDiscoverySelection {
  readonly solution?: string;
  readonly project?: string;
}

export interface CSharpProjectManifest {
  readonly path: string;
  readonly targetFramework?: string;
  readonly langVersion?: string;
  readonly references: readonly string[];
  readonly files: readonly string[];
}

export interface CSharpSolutionManifest {
  readonly path: string;
  readonly projects: readonly string[];
}

/**
 * The only data approved by the C# discovery boundary. It deliberately has no
 * XML, source text, absolute path, compiler, restore, or package fields.
 */
export interface CSharpManifest {
  readonly language: 'csharp';
  readonly selection: {
    readonly kind: CSharpSelectionKind;
    readonly path: string;
  };
  readonly solution?: CSharpSolutionManifest;
  readonly projects: readonly CSharpProjectManifest[];
}

export type CSharpDiscoveryDiagnosticCode =
  | 'invalid_selection'
  | 'path_invalid'
  | 'xml_invalid'
  | 'unsupported_construct'
  | 'io_error'
  | 'resource_limit';

export interface CSharpDiscoveryDiagnostic {
  readonly code: CSharpDiscoveryDiagnosticCode;
  readonly severity: 'error';
  readonly message: string;
  readonly path?: string;
}

export interface CSharpManifestResult {
  readonly manifest?: CSharpManifest;
  readonly diagnostics: readonly CSharpDiscoveryDiagnostic[];
}

export interface DiscoverCSharpManifestOptions {
  readonly filesystem?: DiscoveryFileSystem;
}
