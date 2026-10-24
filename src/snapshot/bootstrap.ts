import { decode, MAX_BYTES } from './codec.js';
import { readFileBounded, type DiscoveryStats } from '../discovery.js';
import {
  revalidateSnapshotPath,
  resolveSnapshotPath,
  sameIdentity,
} from './path.js';
import { SnapshotError, type Snapshot } from './types.js';

export async function openValidatedSnapshot(
  root: string,
  snapshotPath?: string,
): Promise<Snapshot> {
  const target = await resolveSnapshotPath(root, snapshotPath);
  if (target.destinationIdentity === undefined)
    throw new SnapshotError(
      'missing_snapshot',
      'The snapshot could not be found.',
    );
  const beforeRead = await revalidateSnapshotPath(target);
  if (
    beforeRead === undefined ||
    !sameIdentity(target.destinationIdentity, beforeRead)
  )
    throw new SnapshotError('path_invalid', 'The snapshot path is invalid.');
  try {
    const expected: DiscoveryStats = {
      dev: target.destinationIdentity.dev,
      ino: target.destinationIdentity.ino,
      size: target.destinationIdentity.size,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const bytes = await readFileBounded(target.path, MAX_BYTES, expected);
    const afterRead = await revalidateSnapshotPath(target);
    if (
      afterRead === undefined ||
      !sameIdentity(target.destinationIdentity, afterRead)
    )
      throw new SnapshotError('path_invalid', 'The snapshot path is invalid.');
    return decode(bytes);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (
      ['ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL', 'EAGAIN'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw new SnapshotError('path_invalid', 'The snapshot path is invalid.');
    if ((error as NodeJS.ErrnoException).code === 'EFBIG')
      throw new SnapshotError('invalid_snapshot', 'Invalid snapshot limits.');
    throw new SnapshotError('snapshot_io', 'The snapshot could not be read.');
  }
}
