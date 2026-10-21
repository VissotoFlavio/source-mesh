import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface BoundedHostState {
  readonly blockedPaths: Set<string>;
  readonly defaultLibRoot: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function regularFile(fileName: string): boolean {
  try {
    return fs.statSync(fileName, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

export function createBoundedCompilerHost(
  repositoryRoot: string,
  options: ts.CompilerOptions,
): { host: ts.CompilerHost; state: BoundedHostState } {
  const base = ts.createCompilerHost(options, true);
  const defaultLibRoot = ts.sys.resolvePath(
    path.dirname(ts.getDefaultLibFilePath(options)),
  );
  const state: BoundedHostState = { blockedPaths: new Set(), defaultLibRoot };
  const allowed = (fileName: string): string | undefined => {
    const resolved = ts.sys.resolvePath(fileName);
    let realPath: string;
    try {
      realPath = ts.sys.resolvePath(fs.realpathSync.native(resolved));
    } catch {
      state.blockedPaths.add(resolved);
      return undefined;
    }
    if (
      (inside(repositoryRoot, resolved) && inside(repositoryRoot, realPath)) ||
      inside(defaultLibRoot, realPath)
    )
      return realPath;
    state.blockedPaths.add(resolved);
    return undefined;
  };

  const host: ts.CompilerHost = {
    ...base,
    fileExists: (fileName) => {
      const allowedName = allowed(fileName);
      return (
        allowedName !== undefined &&
        regularFile(allowedName) &&
        base.fileExists(allowedName)
      );
    },
    readFile: (fileName) => {
      const allowedName = allowed(fileName);
      if (allowedName === undefined || !regularFile(allowedName))
        return undefined;
      return base.readFile(allowedName);
    },
    realpath: (fileName) => allowed(fileName) ?? fileName,
    getCanonicalFileName: base.getCanonicalFileName,
  };
  return { host, state };
}

export function createParseConfigHost(
  repositoryRoot: string,
  approvedAbsoluteFiles: readonly string[],
  state: BoundedHostState,
): ts.ParseConfigHost {
  const approved = new Set(approvedAbsoluteFiles);
  const readFile = (fileName: string): string | undefined => {
    const resolved = ts.sys.resolvePath(fileName);
    try {
      const realPath = ts.sys.resolvePath(fs.realpathSync.native(resolved));
      if (
        !inside(repositoryRoot, realPath) ||
        (!approved.has(resolved) && !inside(repositoryRoot, resolved))
      ) {
        state.blockedPaths.add(resolved);
        return undefined;
      }
      if (!regularFile(realPath)) return undefined;
      return ts.sys.readFile(realPath);
    } catch {
      return undefined;
    }
  };
  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: (rootDir, extensions, excludes, includes, depth) =>
      inside(repositoryRoot, ts.sys.resolvePath(rootDir))
        ? ts.sys
            .readDirectory(rootDir, extensions, excludes, includes, depth)
            .filter((fileName) => {
              const resolved = ts.sys.resolvePath(fileName);
              return approved.has(resolved);
            })
        : [],
    fileExists: (fileName) => readFile(fileName) !== undefined,
    readFile,
    trace: () => undefined,
  };
}
