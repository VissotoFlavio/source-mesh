import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { decode, MAX_BYTES } from './codec.js';
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
    if (opened.size > MAX_BYTES)
      throw new SnapshotError('invalid_snapshot', 'Invalid snapshot limits.');
    const buffer = Buffer.allocUnsafe(
      Math.min(MAX_BYTES + 1, Math.max(1, opened.size + 1)),
    );
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
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
