import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { isWindowsUnsafePath } from '../discovery.js';
import { SnapshotError } from './types.js';

export const DEFAULT_SNAPSHOT_PATH = '.sourcemesh/graph.json';
export const SNAPSHOT_DIRECTORY = '.sourcemesh/snapshots';
const SNAPSHOT_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const RESERVED_SNAPSHOT_IDS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * Snapshot identifiers are deliberately ASCII-only so their on-disk spelling is
 * stable across filesystems. They are 1-64 lowercase letters, digits, and
 * hyphens, and must start with a letter.
 */
export function snapshotPathForId(id: string): string {
  if (
    typeof id !== 'string' ||
    !SNAPSHOT_ID.test(id) ||
    RESERVED_SNAPSHOT_IDS.has(id)
  )
    throw invalid();
  return `${SNAPSHOT_DIRECTORY}/${id}.json`;
}

/** Permits only a versioned snapshot, plus the explicit legacy migration path. */
export function isReadableSnapshotPath(selected: string): boolean {
  if (selected === DEFAULT_SNAPSHOT_PATH) return true;
  if (
    !selected.startsWith(`${SNAPSHOT_DIRECTORY}/`) ||
    !selected.endsWith('.json')
  )
    return false;
  const id = selected.slice(SNAPSHOT_DIRECTORY.length + 1, -'.json'.length);
  try {
    return snapshotPathForId(id) === selected;
  } catch {
    return false;
  }
}

export function isVersionedSnapshotPath(selected: string): boolean {
  return selected !== DEFAULT_SNAPSHOT_PATH && isReadableSnapshotPath(selected);
}
function invalid(): SnapshotError {
  return new SnapshotError('path_invalid', 'The snapshot path is invalid.');
}
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
export interface SnapshotIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
}
export interface ResolvedSnapshotPath {
  readonly root: string;
  readonly path: string;
  readonly parent: string;
  readonly parentIdentity: SnapshotIdentity | undefined;
  readonly destinationIdentity: SnapshotIdentity | undefined;
}
function identity(stat: {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
}): SnapshotIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}
function sameIdentity(
  left: SnapshotIdentity,
  right: SnapshotIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}
function sameObjectIdentity(
  left: SnapshotIdentity,
  right: SnapshotIdentity,
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}
async function validateParents(
  root: string,
  parent: string,
  allowMissingParents: boolean,
): Promise<SnapshotIdentity | undefined> {
  const relative = path.relative(root, parent);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      const item = await lstat(current);
      if (!item.isDirectory() || item.isSymbolicLink()) throw invalid();
      if (index === segments.length - 1) return identity(item);
    } catch (error) {
      if (error instanceof SnapshotError) throw error;
      if (allowMissingParents) return undefined;
      throw invalid();
    }
  }
  throw invalid();
}
async function validateDestination(
  target: string,
): Promise<SnapshotIdentity | undefined> {
  try {
    const item = await lstat(target);
    if (!item.isFile() || item.isSymbolicLink()) throw invalid();
    return identity(item);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid();
  }
}
export async function resolveSnapshotPath(
  rootInput: string,
  selected: string,
): Promise<ResolvedSnapshotPath> {
  if (
    typeof selected !== 'string' ||
    selected.length === 0 ||
    selected.includes('\0') ||
    isWindowsUnsafePath(selected) ||
    path.isAbsolute(selected) ||
    /^[A-Za-z]:[\\/]/.test(selected) ||
    selected.startsWith('\\\\')
  )
    throw invalid();
  const normalized = selected.split(/[\\/]+/).join('/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.'))
    throw invalid();
  if (!isReadableSnapshotPath(normalized)) throw invalid();
  const root = await realpath(rootInput).catch(() => {
    throw invalid();
  });
  const target = path.resolve(root, ...parts);
  if (!contained(root, target) || !contained(root, path.dirname(target)))
    throw invalid();
  const parent = path.dirname(target);
  const allowMissingSnapshotDirectory =
    parent === path.join(root, '.sourcemesh') ||
    parent === path.join(root, '.sourcemesh', 'snapshots');
  const parentIdentity = await validateParents(
    root,
    parent,
    allowMissingSnapshotDirectory,
  );
  if (parentIdentity === undefined)
    return {
      root,
      path: target,
      parent,
      parentIdentity,
      destinationIdentity: undefined,
    };
  const parentReal = await realpath(parent).catch(() => {
    throw invalid();
  });
  if (!contained(root, parentReal)) throw invalid();
  return {
    root,
    path: target,
    parent,
    parentIdentity,
    destinationIdentity: await validateDestination(target),
  };
}
export async function revalidateSnapshotPath(
  resolved: ResolvedSnapshotPath,
): Promise<SnapshotIdentity | undefined> {
  const parentItem = await lstat(resolved.parent).catch(() => {
    throw invalid();
  });
  if (
    !parentItem.isDirectory() ||
    parentItem.isSymbolicLink() ||
    resolved.parentIdentity === undefined ||
    !sameObjectIdentity(resolved.parentIdentity, identity(parentItem))
  )
    throw invalid();
  return validateDestination(resolved.path);
}
export { sameIdentity, sameObjectIdentity };
