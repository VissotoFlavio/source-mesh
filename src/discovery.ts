import { promises as fs } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const RESERVED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.bzr',
  '.sourcemesh',
  'node_modules',
  'build',
  'coverage',
  'dist',
  'generated',
  'out',
  '.next',
  'storybook-static',
]);

const MAX_DISCOVERY_ROOTS = 10_000;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_PATH_DEPTH = 256;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_AGGREGATE_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_SERIALIZED_PATH_BYTES = 16 * 1024;

export type DiscoveryPathReason =
  | 'root_missing'
  | 'root_not_directory'
  | 'root_inaccessible'
  | 'entry_inaccessible'
  | 'entry_missing'
  | 'entry_not_regular'
  | 'symlink_skipped'
  | 'path_escape'
  | 'entry_replaced';

export type DiscoveryLimitReason =
  | 'path_depth_exceeded'
  | 'source_size_exceeded'
  | 'discovery_roots_exceeded'
  | 'directory_entries_exceeded'
  | 'source_bytes_exceeded'
  | 'serialized_path_exceeded';

export interface DiscoveryStats {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface DiscoveryDirent {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Filesystem boundary kept injectable for deterministic race-condition tests. */
export interface DiscoveryFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<DiscoveryStats>;
  lstat(path: string): Promise<DiscoveryStats>;
  readdir(path: string): Promise<readonly DiscoveryDirent[]>;
}

export interface DiscoverSourceFilesOptions {
  readonly filesystem?: DiscoveryFileSystem;
}

interface PathInvalidDiagnostic {
  readonly code: 'path_invalid';
  readonly severity: 'error';
  readonly message: 'Repository-relative path is invalid.';
  readonly reason: DiscoveryPathReason;
  readonly path?: string;
}

interface ResourceLimitDiagnostic {
  readonly code: 'resource_limit';
  readonly severity: 'error';
  readonly message: 'The analysis resource limit was exceeded.';
  readonly reason: DiscoveryLimitReason;
  readonly path?: string;
}

/** The closed, sanitized diagnostic shape used by local discovery. */
export type DiscoveryDiagnostic =
  PathInvalidDiagnostic | ResourceLimitDiagnostic;

/** Discovery output. A limit failure returns no partial source list. */
export interface DiscoveryResult {
  readonly repositoryRoot?: string;
  readonly sources: readonly string[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

interface DiscoveryState {
  readonly root: string;
  readonly filesystem: DiscoveryFileSystem;
  readonly sources: string[];
  readonly diagnostics: DiscoveryDiagnostic[];
  readonly visitedDirectories: Set<string>;
  inspectedEntries: number;
  sourceBytes: number;
  failed: boolean;
}

const defaultFilesystem: DiscoveryFileSystem = {
  realpath: (candidate) => fs.realpath(candidate),
  stat: (candidate) => fs.stat(candidate),
  lstat: (candidate) => fs.lstat(candidate),
  readdir: async (directory) => fs.readdir(directory, { withFileTypes: true }),
};

function compareOrdinal(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function compareOptionalPath(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === undefined && right !== undefined) return 1;
  if (left !== undefined && right === undefined) return -1;
  if (left === undefined || right === undefined) return 0;
  return compareOrdinal(left, right);
}

function diagnostic(
  reason: DiscoveryPathReason,
  relativePath?: string,
): DiscoveryDiagnostic {
  return {
    code: 'path_invalid',
    severity: 'error',
    message: 'Repository-relative path is invalid.',
    reason,
    ...(relativePath === undefined ? {} : { path: relativePath }),
  };
}

function limitDiagnostic(
  reason: DiscoveryLimitReason,
  relativePath?: string,
): DiscoveryDiagnostic {
  return {
    code: 'resource_limit',
    severity: 'error',
    message: 'The analysis resource limit was exceeded.',
    reason,
    ...(relativePath === undefined ? {} : { path: relativePath }),
  };
}

function sortDiagnostics(diagnostics: DiscoveryDiagnostic[]): void {
  diagnostics.sort((left, right) => {
    return (
      compareOptionalPath(left.path, right.path) ||
      compareOrdinal(left.reason, right.reason) ||
      compareOrdinal(left.code, right.code)
    );
  });
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function isSerializedPathTooLong(relativePath: string): boolean {
  return Buffer.byteLength(relativePath, 'utf8') > MAX_SERIALIZED_PATH_BYTES;
}

function toRepositoryPath(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, candidate);
  if (!isContained(root, candidate)) return undefined;
  const portable = relative.split(path.sep).join('/');
  if (
    portable.length === 0 ||
    portable.startsWith('/') ||
    portable
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return portable;
}

function hasReservedDirectory(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((segment) => RESERVED_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

function isSecretFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return (
    basename === '.env' ||
    basename.startsWith('.env.') ||
    basename.endsWith('.env') ||
    basename.endsWith('.secret') ||
    basename.endsWith('.secrets') ||
    basename.endsWith('.key') ||
    basename === 'id_rsa' ||
    basename === 'id_ed25519' ||
    basename === '.npmrc' ||
    basename === '.pypirc' ||
    basename === 'credentials'
  );
}

function isDeclaration(relativePath: string): boolean {
  return /\.d\.(ts|mts|cts)$/.test(relativePath);
}

function isSource(relativePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(relativePath));
}

function pathDepth(relativePath: string): number {
  return relativePath.split('/').length;
}

function addDiagnostic(state: DiscoveryState, item: DiscoveryDiagnostic): void {
  state.diagnostics.push(item);
}

function failLimit(
  state: DiscoveryState,
  reason: DiscoveryLimitReason,
  relativePath?: string,
): void {
  state.failed = true;
  state.sources.length = 0;
  addDiagnostic(state, limitDiagnostic(reason, relativePath));
}

function failClosed(
  state: DiscoveryState,
  reason: DiscoveryPathReason,
  relativePath?: string,
): void {
  state.failed = true;
  state.sources.length = 0;
  addDiagnostic(state, diagnostic(reason, relativePath));
}

function classifyFilesystemError(error: unknown): 'missing' | 'inaccessible' {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
}

function sameIdentity(left: DiscoveryStats, right: DiscoveryStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

async function inspectDirectory(
  state: DiscoveryState,
  directory: string,
): Promise<void> {
  if (state.failed) return;

  let directoryStats: DiscoveryStats;
  try {
    directoryStats = await state.filesystem.lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      addDiagnostic(
        state,
        diagnostic(
          'entry_not_regular',
          toRepositoryPath(state.root, directory),
        ),
      );
      return;
    }
    const canonicalDirectory = await state.filesystem.realpath(directory);
    const afterRealpathStats = await state.filesystem.lstat(directory);
    if (!sameIdentity(directoryStats, afterRealpathStats)) {
      failClosed(
        state,
        'entry_replaced',
        toRepositoryPath(state.root, directory),
      );
      return;
    }
    if (
      canonicalDirectory !== directory ||
      (canonicalDirectory !== state.root &&
        !isContained(state.root, canonicalDirectory))
    ) {
      failClosed(state, 'path_escape', toRepositoryPath(state.root, directory));
      return;
    }
  } catch (error) {
    const reason = classifyFilesystemError(error);
    addDiagnostic(
      state,
      diagnostic(
        reason === 'missing' ? 'entry_missing' : 'entry_inaccessible',
        toRepositoryPath(state.root, directory),
      ),
    );
    return;
  }

  let entries: DiscoveryDirent[];
  try {
    entries = [...(await state.filesystem.readdir(directory))];
  } catch (error) {
    const relativePath = toRepositoryPath(state.root, directory);
    addDiagnostic(
      state,
      diagnostic(
        classifyFilesystemError(error) === 'missing'
          ? 'entry_missing'
          : 'entry_inaccessible',
        relativePath,
      ),
    );
    return;
  }

  let afterReadStats: DiscoveryStats;
  try {
    afterReadStats = await state.filesystem.lstat(directory);
  } catch (error) {
    failClosed(
      state,
      classifyFilesystemError(error) === 'missing'
        ? 'entry_missing'
        : 'entry_inaccessible',
      toRepositoryPath(state.root, directory),
    );
    return;
  }
  if (!sameIdentity(directoryStats, afterReadStats)) {
    failClosed(
      state,
      'entry_replaced',
      toRepositoryPath(state.root, directory),
    );
    return;
  }

  if (state.inspectedEntries + entries.length > MAX_DIRECTORY_ENTRIES) {
    failLimit(
      state,
      'directory_entries_exceeded',
      toRepositoryPath(state.root, directory),
    );
    return;
  }
  state.inspectedEntries += entries.length;

  entries.sort((left, right) => compareOrdinal(left.name, right.name));
  for (const entry of entries) {
    if (state.failed) return;

    const candidate = path.join(directory, entry.name);
    const relativePath = toRepositoryPath(state.root, candidate);
    if (relativePath === undefined) {
      failClosed(state, 'path_escape');
      return;
    }
    if (isSerializedPathTooLong(relativePath)) {
      failLimit(state, 'serialized_path_exceeded');
      return;
    }
    if (pathDepth(relativePath) > MAX_PATH_DEPTH) {
      failLimit(state, 'path_depth_exceeded', relativePath);
      return;
    }
    if (hasReservedDirectory(relativePath) || isSecretFile(relativePath))
      continue;

    if (entry.isSymbolicLink()) {
      addDiagnostic(state, diagnostic('symlink_skipped', relativePath));
      continue;
    }

    let stats;
    try {
      stats = await state.filesystem.lstat(candidate);
    } catch (error) {
      addDiagnostic(
        state,
        diagnostic(
          classifyFilesystemError(error) === 'missing'
            ? 'entry_missing'
            : 'entry_inaccessible',
          relativePath,
        ),
      );
      continue;
    }

    if (stats.isDirectory()) {
      let canonicalDirectory: string;
      try {
        canonicalDirectory = await state.filesystem.realpath(candidate);
      } catch (error) {
        addDiagnostic(
          state,
          diagnostic(
            classifyFilesystemError(error) === 'missing'
              ? 'entry_missing'
              : 'entry_inaccessible',
            relativePath,
          ),
        );
        continue;
      }
      if (!isContained(state.root, canonicalDirectory)) {
        addDiagnostic(state, diagnostic('path_escape', relativePath));
        continue;
      }
      if (state.visitedDirectories.has(canonicalDirectory)) continue;
      state.visitedDirectories.add(canonicalDirectory);
      await inspectDirectory(state, canonicalDirectory);
      continue;
    }

    if (!stats.isFile()) {
      addDiagnostic(state, diagnostic('entry_not_regular', relativePath));
      continue;
    }
    if (!isSource(relativePath) || isDeclaration(relativePath)) continue;
    if (state.sources.length >= MAX_DISCOVERY_ROOTS) {
      failLimit(state, 'discovery_roots_exceeded', relativePath);
      return;
    }
    if (
      stats.size > MAX_SOURCE_BYTES ||
      state.sourceBytes > MAX_AGGREGATE_SOURCE_BYTES - stats.size
    ) {
      failLimit(
        state,
        stats.size > MAX_SOURCE_BYTES
          ? 'source_size_exceeded'
          : 'source_bytes_exceeded',
        relativePath,
      );
      return;
    }

    let canonicalFile: string;
    try {
      canonicalFile = await state.filesystem.realpath(candidate);
    } catch (error) {
      addDiagnostic(
        state,
        diagnostic(
          classifyFilesystemError(error) === 'missing'
            ? 'entry_missing'
            : 'entry_inaccessible',
          relativePath,
        ),
      );
      continue;
    }
    let finalStats;
    try {
      finalStats = await state.filesystem.lstat(candidate);
    } catch (error) {
      addDiagnostic(
        state,
        diagnostic(
          classifyFilesystemError(error) === 'missing'
            ? 'entry_missing'
            : 'entry_inaccessible',
          relativePath,
        ),
      );
      continue;
    }
    if (
      finalStats.isSymbolicLink() ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino
    ) {
      addDiagnostic(state, diagnostic('entry_missing', relativePath));
      continue;
    }
    const canonicalRelativePath = toRepositoryPath(state.root, canonicalFile);
    if (canonicalRelativePath === undefined) {
      addDiagnostic(state, diagnostic('path_escape', relativePath));
      continue;
    }
    if (isSerializedPathTooLong(canonicalRelativePath)) {
      failLimit(state, 'serialized_path_exceeded');
      return;
    }
    if (
      hasReservedDirectory(canonicalRelativePath) ||
      isSecretFile(canonicalRelativePath)
    )
      continue;
    state.sources.push(canonicalRelativePath);
    state.sourceBytes += stats.size;
  }
}

/**
 * Discover approved source roots beneath one explicitly selected local root.
 * The function never reads source contents, follows links, invokes processes,
 * or accesses the network. Errors are sanitized into stable diagnostics.
 */
function isRemoteRoot(selectedRoot: string): boolean {
  return (
    /^[\\/]{2}/.test(selectedRoot) ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(selectedRoot)
  );
}

export async function discoverSourceFiles(
  selectedRoot: string,
  options: DiscoverSourceFilesOptions = {},
): Promise<DiscoveryResult> {
  const empty = (diagnostics: DiscoveryDiagnostic[]): DiscoveryResult => ({
    sources: [],
    diagnostics,
  });

  if (isRemoteRoot(selectedRoot)) {
    return empty([diagnostic('path_escape')]);
  }

  const filesystem = options.filesystem ?? defaultFilesystem;

  let root: string;
  try {
    root = await filesystem.realpath(selectedRoot);
  } catch (error) {
    return empty([
      diagnostic(
        classifyFilesystemError(error) === 'missing'
          ? 'root_missing'
          : 'root_inaccessible',
      ),
    ]);
  }
  let rootStats;
  try {
    rootStats = await filesystem.stat(root);
  } catch (error) {
    return empty([
      diagnostic(
        classifyFilesystemError(error) === 'missing'
          ? 'root_missing'
          : 'root_inaccessible',
      ),
    ]);
  }
  if (!rootStats.isDirectory())
    return empty([diagnostic('root_not_directory')]);

  const state: DiscoveryState = {
    root,
    filesystem,
    sources: [],
    diagnostics: [],
    visitedDirectories: new Set([root]),
    inspectedEntries: 0,
    sourceBytes: 0,
    failed: false,
  };
  await inspectDirectory(state, root);
  if (!state.failed) {
    state.sources.sort(compareOrdinal);
  }
  sortDiagnostics(state.diagnostics);
  return {
    repositoryRoot: root,
    sources: state.sources,
    diagnostics: state.diagnostics,
  };
}
