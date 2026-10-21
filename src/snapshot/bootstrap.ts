import { readFile } from 'node:fs/promises';
import { decode } from './codec.js';
import { resolveSnapshotPath } from './path.js';
import { SnapshotError, type SnapshotV1 } from './types.js';

export async function openValidatedSnapshot(
  root: string,
  snapshotPath?: string,
): Promise<SnapshotV1> {
  const target = await resolveSnapshotPath(root, snapshotPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(target.path);
  } catch {
    throw new SnapshotError(
      'missing_snapshot',
      'The snapshot could not be found.',
    );
  }
  return decode(bytes);
}
