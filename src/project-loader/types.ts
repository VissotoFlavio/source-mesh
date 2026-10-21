import type * as ts from 'typescript';

export const PROJECT_ROOT_EXTENSIONS = [
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
] as const;

export type ProjectRootExtension = (typeof PROJECT_ROOT_EXTENSIONS)[number];

export type CompilerDiagnosticPhase =
  'config' | 'options' | 'syntax' | 'semantic';

export type DiagnosticSeverity = 'error' | 'warning' | 'suggestion' | 'message';

export interface DiagnosticLocation {
  readonly line: number;
  readonly column: number;
  readonly length?: number;
}

export interface ProjectLoaderDiagnostic {
  readonly phase: CompilerDiagnosticPhase;
  readonly code:
    | 'compiler.configuration'
    | 'compiler.options'
    | 'compiler.syntax'
    | 'compiler.semantic';
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly compilerCode?: number;
  readonly path?: string;
  readonly location?: DiagnosticLocation;
}

export interface LoadProjectRequest {
  readonly repositoryRoot: string;
  /** Repository-relative files approved by discovery (#18). */
  readonly approvedFiles: readonly string[];
  /** A single caller-selected config; undefined deliberately means no config. */
  readonly tsconfigPath?: string;
}

export interface LoadedProject {
  readonly program: ts.Program;
  readonly options: ts.CompilerOptions;
  /** Ordered, repository-relative roots; context files are not included. */
  readonly rootNames: readonly string[];
}

export interface LoadProjectResult {
  readonly project: LoadedProject | null;
  readonly diagnostics: readonly ProjectLoaderDiagnostic[];
}
