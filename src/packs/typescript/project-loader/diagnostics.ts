import ts from 'typescript';
import type {
  CompilerDiagnosticPhase,
  ProjectLoaderDiagnostic,
} from './types.js';

const phaseOrder: Record<CompilerDiagnosticPhase, number> = {
  config: 0,
  options: 1,
  syntax: 2,
  semantic: 3,
};

const diagnosticCode: Record<
  CompilerDiagnosticPhase,
  ProjectLoaderDiagnostic['code']
> = {
  config: 'compiler.configuration',
  options: 'compiler.options',
  syntax: 'compiler.syntax',
  semantic: 'compiler.semantic',
};

const diagnosticMessage: Record<CompilerDiagnosticPhase, string> = {
  config: 'Compiler configuration is invalid.',
  options: 'Compiler options are invalid.',
  syntax: 'Source syntax is invalid.',
  semantic: 'Source semantics are invalid.',
};

function portablePath(
  repositoryRoot: string,
  fileName: string,
): string | undefined {
  const root = ts.sys.resolvePath(repositoryRoot);
  const file = ts.sys.resolvePath(fileName);
  const relative = ts.sys
    .resolvePath(file)
    .slice(root.length)
    .replace(/^[/\\]/u, '');
  if (file !== root && relative === file) return undefined;
  if (
    file !== root &&
    !file.startsWith(`${root}/`) &&
    !file.startsWith(`${root}\\`)
  ) {
    return undefined;
  }
  return relative.replaceAll('\\', '/');
}

function compare(
  left: ProjectLoaderDiagnostic,
  right: ProjectLoaderDiagnostic,
): number {
  const path = (left.path ?? '').localeCompare(right.path ?? '');
  if (path !== 0) return path;
  const leftLine = left.location?.line ?? 0;
  const rightLine = right.location?.line ?? 0;
  if (leftLine !== rightLine) return leftLine - rightLine;
  const leftColumn = left.location?.column ?? 0;
  const rightColumn = right.location?.column ?? 0;
  if (leftColumn !== rightColumn) return leftColumn - rightColumn;
  const leftCode = left.compilerCode ?? 0;
  const rightCode = right.compilerCode ?? 0;
  if (leftCode !== rightCode) return leftCode - rightCode;
  return left.message.localeCompare(right.message);
}

export function normalizeCompilerDiagnostics(
  repositoryRoot: string,
  phase: CompilerDiagnosticPhase,
  diagnostics: readonly ts.Diagnostic[],
): ProjectLoaderDiagnostic[] {
  const normalized = diagnostics.map((diagnostic) => {
    const path = diagnostic.file
      ? portablePath(repositoryRoot, diagnostic.file.fileName)
      : undefined;
    const start = diagnostic.start ?? 0;
    const location = diagnostic.file
      ? (() => {
          const position = diagnostic.file.getLineAndCharacterOfPosition(start);
          return {
            line: position.line + 1,
            column: position.character + 1,
            ...(diagnostic.length === undefined
              ? {}
              : { length: diagnostic.length }),
          };
        })()
      : undefined;
    return {
      phase,
      code: diagnosticCode[phase],
      severity: 'error',
      message: diagnosticMessage[phase],
      compilerCode: diagnostic.code,
      ...(path === undefined ? {} : { path }),
      ...(location === undefined ? {} : { location }),
    } satisfies ProjectLoaderDiagnostic;
  });

  const unique = new Map<string, ProjectLoaderDiagnostic>();
  for (const item of normalized) {
    const key = JSON.stringify([
      item.phase,
      item.path ?? '',
      item.location?.line ?? 0,
      item.location?.column ?? 0,
      item.location?.length ?? 0,
      item.compilerCode ?? 0,
      item.message,
    ]);
    unique.set(key, item);
  }
  return [...unique.values()].sort(compare);
}

export function sortDiagnostics(
  diagnostics: readonly ProjectLoaderDiagnostic[],
): ProjectLoaderDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      phaseOrder[left.phase] - phaseOrder[right.phase] || compare(left, right),
  );
}
