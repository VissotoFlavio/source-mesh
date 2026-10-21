import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { SnapshotError } from './types.js';

export const DEFAULT_SNAPSHOT_PATH = '.sourcemesh/graph.json';
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
export async function resolveSnapshotPath(
  rootInput: string,
  selected = DEFAULT_SNAPSHOT_PATH,
): Promise<{ root: string; path: string; parent: string }> {
  if (
    typeof selected !== 'string' ||
    selected.length === 0 ||
    selected.includes('\0') ||
    path.isAbsolute(selected) ||
    /^[A-Za-z]:[\\/]/.test(selected) ||
    selected.startsWith('\\\\')
  )
    throw invalid();
  const normalized = selected.split(/[\\/]+/).join('/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.'))
    throw invalid();
  if (parts[0] !== '.sourcemesh') throw invalid();
  const root = await realpath(rootInput).catch(() => {
    throw invalid();
  });
  const target = path.resolve(root, ...parts);
  if (!contained(root, target) || !contained(root, path.dirname(target)))
    throw invalid();
  const parent = path.dirname(target);
  try {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (
      selected === DEFAULT_SNAPSHOT_PATH &&
      parent === path.join(root, '.sourcemesh')
    )
      return { root, path: target, parent };
    throw invalid();
  }
  const parentReal = await realpath(parent).catch(() => {
    throw invalid();
  });
  if (!contained(root, parentReal)) throw invalid();
  return { root, path: target, parent };
}
