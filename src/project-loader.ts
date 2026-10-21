import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  createBoundedCompilerHost,
  createParseConfigHost,
} from './project-loader/compiler-host.js';
import {
  normalizeCompilerDiagnostics,
  sortDiagnostics,
} from './project-loader/diagnostics.js';
import {
  PROJECT_ROOT_EXTENSIONS,
  type LoadProjectRequest,
  type LoadProjectResult,
  type LoadedProject,
  type ProjectLoaderDiagnostic,
} from './project-loader/types.js';

export * from './project-loader/types.js';

const fallbackOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  checkJs: false,
  noEmit: true,
  resolveJsonModule: false,
  skipLibCheck: true,
  types: [],
};

const extensionSet = new Set<string>(PROJECT_ROOT_EXTENSIONS);

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function diagnostic(
  phase: 'configuration',
  message: string,
  pathName?: string,
): ProjectLoaderDiagnostic {
  return {
    phase,
    code: 'compiler.configuration',
    severity: 'error',
    message,
    ...(pathName === undefined ? {} : { path: pathName }),
  };
}

function relativePath(root: string, fileName: string): string {
  return path.relative(root, fileName).replaceAll(path.sep, '/');
}

function canonicalFile(root: string, value: string): string | undefined {
  if (path.isAbsolute(value) || value.includes('\0')) return undefined;
  const candidate = path.resolve(root, value);
  if (!inside(root, candidate)) return undefined;
  return candidate;
}

function validateRoots(
  root: string,
  values: readonly string[],
): { absolute: string[]; diagnostics: ProjectLoaderDiagnostic[] } {
  const diagnostics: ProjectLoaderDiagnostic[] = [];
  const absolute: string[] = [];
  const seen = new Set<string>();
  if (values.length > 10_000) {
    diagnostics.push(diagnostic('configuration', 'resource limit exceeded'));
    return { absolute, diagnostics };
  }
  for (const value of values) {
    const canonical = canonicalFile(root, value);
    const extension = path.extname(value).toLowerCase();
    if (
      canonical === undefined ||
      !extensionSet.has(extension) ||
      /\.d\.(?:ts|mts|cts)$/iu.test(value)
    ) {
      diagnostics.push(
        diagnostic('configuration', 'invalid approved source root'),
      );
      continue;
    }
    if (!fs.existsSync(canonical) || !fs.statSync(canonical).isFile()) {
      diagnostics.push(
        diagnostic(
          'configuration',
          'approved source root is unavailable',
          value,
        ),
      );
      continue;
    }
    if (fs.statSync(canonical).size > 4 * 1024 * 1024) {
      diagnostics.push(
        diagnostic(
          'configuration',
          'source file resource limit exceeded',
          value,
        ),
      );
      continue;
    }
    const real = fs.realpathSync.native(canonical);
    if (real !== canonical || !inside(root, real)) {
      diagnostics.push(
        diagnostic(
          'configuration',
          'approved source root escapes repository',
          value,
        ),
      );
      continue;
    }
    if (!seen.has(real)) {
      seen.add(real);
      absolute.push(real);
    }
  }
  absolute.sort((left, right) =>
    relativePath(root, left).localeCompare(relativePath(root, right)),
  );
  return { absolute, diagnostics };
}

function validatePackageTypes(
  root: string,
  roots: readonly string[],
): ProjectLoaderDiagnostic[] {
  const diagnostics: ProjectLoaderDiagnostic[] = [];
  for (const source of roots) {
    let current = path.dirname(source);
    while (inside(root, current)) {
      const packagePath = path.join(current, 'package.json');
      if (fs.existsSync(packagePath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
            type?: unknown;
          };
          if (
            parsed.type !== undefined &&
            parsed.type !== 'module' &&
            parsed.type !== 'commonjs'
          ) {
            diagnostics.push(
              diagnostic(
                'configuration',
                'unsupported package type',
                relativePath(root, packagePath),
              ),
            );
          }
        } catch {
          diagnostics.push(
            diagnostic(
              'configuration',
              'invalid package metadata',
              relativePath(root, packagePath),
            ),
          );
        }
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return diagnostics;
}

function loadConfigured(
  root: string,
  configPath: string,
  approved: readonly string[],
): { project: LoadedProject | null; diagnostics: ProjectLoaderDiagnostic[] } {
  const normalizedConfigPath = ts.sys.resolvePath(configPath);
  const state = { blockedPaths: new Set<string>(), defaultLibRoot: '' };
  let config: ReturnType<typeof ts.readConfigFile>;
  try {
    config = ts.readConfigFile(normalizedConfigPath, (fileName) => {
      const resolved = ts.sys.resolvePath(fileName);
      let realPath: string;
      try {
        realPath = ts.sys.resolvePath(fs.realpathSync.native(resolved));
      } catch {
        state.blockedPaths.add(resolved);
        return undefined;
      }
      if (!inside(root, resolved) || !inside(root, realPath)) {
        state.blockedPaths.add(resolved);
        return undefined;
      }
      if (fs.statSync(realPath).size > 4 * 1024 * 1024) {
        state.blockedPaths.add(resolved);
        return undefined;
      }
      return ts.sys.readFile(realPath);
    });
  } catch {
    return {
      project: null,
      diagnostics: [
        diagnostic('configuration', 'invalid project configuration'),
      ],
    };
  }
  const configuration = normalizeCompilerDiagnostics(
    root,
    'configuration',
    config.error ? [config.error] : [],
  );
  if (config.config === undefined || state.blockedPaths.size > 0) {
    return {
      project: null,
      diagnostics: configuration.length
        ? configuration
        : [diagnostic('configuration', 'invalid project configuration')],
    };
  }
  const options = { ...fallbackOptions };
  const { state: hostState } = createBoundedCompilerHost(root, options);
  const parseHost = createParseConfigHost(root, approved, hostState);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    parseHost,
    path.dirname(normalizedConfigPath),
    { noEmit: true },
    normalizedConfigPath,
  );
  const parseDiagnostics = normalizeCompilerDiagnostics(
    root,
    'configuration',
    parsed.errors,
  );
  const allConfigDiagnostics = [...configuration, ...parseDiagnostics];
  if (hostState.blockedPaths.size > 0)
    allConfigDiagnostics.push(
      diagnostic(
        'configuration',
        'configuration reads outside repository are not allowed',
      ),
    );
  const approvedSet = new Set(approved);
  const parsedRoots = parsed.fileNames.map((fileName) =>
    ts.sys.resolvePath(fileName),
  );
  const roots = parsedRoots.filter((fileName) => {
    if (/\.d\.(?:ts|mts|cts)$/iu.test(fileName)) return false;
    return approvedSet.has(fileName);
  });
  if (
    parsedRoots.some(
      (fileName) =>
        !approvedSet.has(fileName) && !/\.d\.(?:ts|mts|cts)$/iu.test(fileName),
    )
  ) {
    allConfigDiagnostics.push(
      diagnostic(
        'configuration',
        'configuration selected an unapproved source root',
      ),
    );
  }
  if (
    parsed.projectReferences?.some((reference) => {
      try {
        return !inside(root, fs.realpathSync.native(reference.path));
      } catch {
        return true;
      }
    })
  ) {
    allConfigDiagnostics.push(
      diagnostic('configuration', 'project reference escapes repository'),
    );
  }
  if (allConfigDiagnostics.length > 0)
    return { project: null, diagnostics: allConfigDiagnostics };
  const effectiveOptions = { ...parsed.options, noEmit: true };
  const bounded = createBoundedCompilerHost(root, effectiveOptions);
  const program = ts.createProgram(roots, effectiveOptions, bounded.host);
  const compilerDiagnostics = [
    ...normalizeCompilerDiagnostics(
      root,
      'options',
      program.getOptionsDiagnostics(),
    ),
    ...normalizeCompilerDiagnostics(
      root,
      'syntax',
      program.getSyntacticDiagnostics(),
    ),
    ...normalizeCompilerDiagnostics(
      root,
      'semantic',
      program.getSemanticDiagnostics(),
    ),
  ];
  if (bounded.state.blockedPaths.size > 0)
    compilerDiagnostics.push(
      diagnostic('configuration', 'module resolution escaped repository'),
    );
  return {
    project: {
      program,
      options: effectiveOptions,
      rootNames: roots.map((fileName) => relativePath(root, fileName)).sort(),
    },
    diagnostics: compilerDiagnostics,
  };
}

export function loadProject(request: LoadProjectRequest): LoadProjectResult {
  let root: string;
  try {
    root = fs.realpathSync.native(path.resolve(request.repositoryRoot));
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    return {
      project: null,
      diagnostics: [diagnostic('configuration', 'invalid repository root')],
    };
  }
  const roots = validateRoots(root, request.approvedFiles);
  const diagnostics = [
    ...roots.diagnostics,
    ...validatePackageTypes(root, roots.absolute),
  ];
  if (diagnostics.length > 0)
    return { project: null, diagnostics: sortDiagnostics(diagnostics) };

  if (request.tsconfigPath !== undefined) {
    const requestedConfig = path.resolve(root, request.tsconfigPath);
    let configPath: string | undefined;
    try {
      const realConfig = fs.realpathSync.native(requestedConfig);
      if (inside(root, realConfig)) configPath = realConfig;
    } catch {
      configPath = undefined;
    }
    if (
      configPath === undefined ||
      path.basename(configPath) !== 'tsconfig.json' ||
      !fs.statSync(configPath).isFile()
    ) {
      return {
        project: null,
        diagnostics: [
          diagnostic('configuration', 'invalid project configuration'),
        ],
      };
    }
    const result = loadConfigured(root, configPath, roots.absolute);
    return {
      project: result.project,
      diagnostics: sortDiagnostics([...diagnostics, ...result.diagnostics]),
    };
  }

  const { host, state } = createBoundedCompilerHost(root, fallbackOptions);
  const program = ts.createProgram(roots.absolute, fallbackOptions, host);
  const result: LoadedProject = {
    program,
    options: fallbackOptions,
    rootNames: roots.absolute
      .map((fileName) => relativePath(root, fileName))
      .sort(),
  };
  const compilerDiagnostics = [
    ...normalizeCompilerDiagnostics(
      root,
      'options',
      program.getOptionsDiagnostics(),
    ),
    ...normalizeCompilerDiagnostics(
      root,
      'syntax',
      program.getSyntacticDiagnostics(),
    ),
    ...normalizeCompilerDiagnostics(
      root,
      'semantic',
      program.getSemanticDiagnostics(),
    ),
  ];
  if (state.blockedPaths.size > 0)
    compilerDiagnostics.push(
      diagnostic('configuration', 'module resolution escaped repository'),
    );
  return { project: result, diagnostics: sortDiagnostics(compilerDiagnostics) };
}

export { fallbackOptions as PROJECT_LOADER_FALLBACK_OPTIONS };
