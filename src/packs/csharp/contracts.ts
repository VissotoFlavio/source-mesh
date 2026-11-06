import {
  isSerializedPathTooLong,
  MAX_PATH_DEPTH,
  normalizeRelativePath,
  pathDepth,
  pathIdentityKey,
  type DiscoveryFileSystem,
} from '../../discovery.js';

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

/** The versioned contract for every explicit C# project selection. */
export const CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION = 1;

export interface CSharpExplicitProjectSelection {
  readonly version: typeof CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION;
  readonly kind: 'explicit-projects';
  /** Canonical, root-relative .csproj paths in UTF-8 ordinal order. */
  readonly projects: readonly string[];
}

export type CSharpExplicitProjectSelectionDiagnosticCode =
  'empty' | 'path_invalid' | 'project_invalid' | 'duplicate' | 'resource_limit';

export interface CSharpExplicitProjectSelectionDiagnostic {
  readonly version: typeof CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION;
  readonly code: CSharpExplicitProjectSelectionDiagnosticCode;
}

export type CSharpExplicitProjectSelectionResult =
  | {
      readonly selection: CSharpExplicitProjectSelection;
      readonly diagnostic?: never;
    }
  | {
      readonly selection?: never;
      readonly diagnostic: CSharpExplicitProjectSelectionDiagnostic;
    };

/** Compares canonical C# contract values by their UTF-8 byte sequence. */
export function compareCSharpUtf8Ordinal(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isPathOverBudget(value: string): boolean {
  return isSerializedPathTooLong(value) || pathDepth(value) > MAX_PATH_DEPTH;
}

/**
 * Forms the versioned selection value only; it must not resolve or discover
 * projects. Filesystem containment, reparse-point, and physical-alias checks
 * remain the responsibility of the later manifest boundary.
 */
export function createCSharpExplicitProjectSelection(
  requestedProjects: readonly string[],
): CSharpExplicitProjectSelectionResult {
  if (requestedProjects.length === 0)
    return {
      diagnostic: {
        version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
        code: 'empty',
      },
    };
  if (requestedProjects.length > CSHARP_MAX_PROJECTS)
    return {
      diagnostic: {
        version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
        code: 'resource_limit',
      },
    };

  const projects = new Map<string, string>();
  for (let index = 0; index < requestedProjects.length; index += 1) {
    const requested = requestedProjects[index];
    if (typeof requested !== 'string')
      return {
        diagnostic: {
          version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
          code: 'path_invalid',
        },
      };
    if (!isWellFormedUtf16(requested))
      return {
        diagnostic: {
          version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
          code: 'path_invalid',
        },
      };
    if (isSerializedPathTooLong(requested))
      return {
        diagnostic: {
          version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
          code: 'resource_limit',
        },
      };
    const portable = normalizeRelativePath(requested);
    if (portable === undefined)
      return {
        diagnostic: {
          version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
          code: 'path_invalid',
        },
      };
    const normalized = portable.normalize('NFC');
    if (isPathOverBudget(portable) || isPathOverBudget(normalized))
      return {
        diagnostic: {
          version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
          code: 'resource_limit',
        },
      };
    if (!normalized.toLowerCase().endsWith('.csproj'))
      return {
        diagnostic: {
          version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
          code: 'project_invalid',
        },
      };
    const key = pathIdentityKey(normalized);
    if (projects.has(key))
      return {
        diagnostic: {
          version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
          code: 'duplicate',
        },
      };
    projects.set(key, normalized);
  }

  return {
    selection: Object.freeze({
      version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
      kind: 'explicit-projects',
      projects: Object.freeze(
        [...projects.values()].sort(compareCSharpUtf8Ordinal),
      ),
    }),
  };
}

export type CSharpSelectionKind = 'solution';

export interface CSharpDiscoverySelection {
  readonly solution: string;
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

/**
 * A manifest produced from the versioned explicit-project selection contract.
 * Its project list is the complete analysis boundary: project references that
 * are not listed here remain external to the local Roslyn compilation.
 */
export interface CSharpExplicitProjectManifest {
  readonly language: 'csharp';
  readonly selection: CSharpExplicitProjectSelection;
  readonly projects: readonly CSharpProjectManifest[];
}

/**
 * A C# manifest accepted by the local, offline analysis pipeline. Solution
 * selection is distinct from explicit project selection, which analyzes
 * exactly the named projects.
 */
export type CSharpAnalysisManifest =
  CSharpManifest | CSharpExplicitProjectManifest;

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

export interface CSharpExplicitProjectManifestResult {
  readonly manifest?: CSharpExplicitProjectManifest;
  readonly diagnostics: readonly CSharpDiscoveryDiagnostic[];
}

export type CSharpWorkerNodeKind =
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'function'
  | 'variable'
  | 'type'
  | 'parameter';

export type CSharpWorkerMemberRole = 'none' | 'static' | 'instance';

export interface CSharpWorkerSymbol {
  readonly kind: CSharpWorkerNodeKind;
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly memberRole: CSharpWorkerMemberRole;
}

export interface CSharpWorkerPosition {
  readonly line: number;
  readonly column: number;
}

export interface CSharpWorkerLocation {
  readonly path: string;
  readonly start: CSharpWorkerPosition;
  readonly end: CSharpWorkerPosition;
}

export interface CSharpWorkerDeclaration extends CSharpWorkerSymbol {
  readonly parent: CSharpWorkerSymbol;
  readonly locations: readonly CSharpWorkerLocation[];
}

export type CSharpWorkerRelationshipKind =
  'uses' | 'extends' | 'implements' | 'calls';

export type CSharpWorkerRelationshipStatus =
  | 'resolved'
  | 'external'
  | 'unresolved'
  | 'ambiguous'
  | 'dynamic'
  | 'unsupported'
  | 'missing-source';

export interface CSharpWorkerRelationship {
  readonly kind: CSharpWorkerRelationshipKind;
  readonly status: CSharpWorkerRelationshipStatus;
  readonly source: CSharpWorkerSymbol;
  readonly target?: CSharpWorkerSymbol;
  readonly location?: CSharpWorkerLocation;
}

export interface CSharpWorkerProjectResult {
  readonly path: string;
  readonly sourceCount: number;
  readonly syntaxTreeCount: number;
  readonly diagnosticCount: number;
  readonly declarations?: readonly CSharpWorkerDeclaration[];
  readonly relationships?: readonly CSharpWorkerRelationship[];
}

export interface DiscoverCSharpManifestOptions {
  readonly filesystem?: DiscoveryFileSystem;
}
