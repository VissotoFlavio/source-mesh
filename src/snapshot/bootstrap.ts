import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { decode } from './codec.js';
import {
  revalidateSnapshotPath,
  resolveSnapshotPath,
  sameIdentity,
} from './path.js';
import { SnapshotError, type SnapshotV1 } from './types.js';

export async function openValidatedSnapshot(
  root: string,
  snapshotPath?: string,
): Promise<SnapshotV1> {
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
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target.path, flags);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameIdentity(target.destinationIdentity, {
        dev: opened.dev,
        ino: opened.ino,
        mode: opened.mode,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
      })
    )
      throw new SnapshotError('path_invalid', 'The snapshot path is invalid.');
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      !sameIdentity(target.destinationIdentity, {
        dev: afterRead.dev,
        ino: afterRead.ino,
        mode: afterRead.mode,
        size: afterRead.size,
        mtimeMs: afterRead.mtimeMs,
      })
    )
      throw new SnapshotError('path_invalid', 'The snapshot path is invalid.');
    return decode(bytes);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError('snapshot_io', 'The snapshot could not be read.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
