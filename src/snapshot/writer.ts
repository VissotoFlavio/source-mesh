import { randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { encode, snapshotDigest } from './codec.js';
import { resolveSnapshotPath } from './path.js';
import {
  SnapshotError,
  type SnapshotV1,
  type SnapshotWriteMode,
  type SnapshotWriteResult,
} from './types.js';

function io(): SnapshotError {
  return new SnapshotError('snapshot_io', 'The snapshot could not be written.');
}
function conflict(): SnapshotError {
  return new SnapshotError('snapshot_conflict', 'The snapshot already exists.');
}
async function existsRegular(file: string): Promise<boolean> {
  try {
    const item = await stat(file);
    return item.isFile();
  } catch {
    return false;
  }
}

export async function writeSnapshot(
  root: string,
  snapshot: SnapshotV1,
  options: { readonly path?: string; readonly mode: SnapshotWriteMode },
): Promise<SnapshotWriteResult> {
  const bytes = encode(snapshot);
  const resolved = await resolveSnapshotPath(root, options.path);
  if (options.mode === 'create-only' && (await existsRegular(resolved.path)))
    throw conflict();
  if (options.mode === 'replace') {
    try {
      const item = await stat(resolved.path);
      if (!item.isFile()) throw io();
    } catch (error) {
      if (error instanceof SnapshotError) throw error;
    }
  }
  if (
    resolved.path === `${resolved.root}/.sourcemesh/graph.json` ||
    resolved.path === `${resolved.root}\\.sourcemesh\\graph.json`
  )
    await mkdir(resolved.parent, { recursive: true, mode: 0o700 }).catch(
      () => undefined,
    );
  const temporary = `${resolved.path}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.mode === 'create-only') {
      try {
        await link(temporary, resolved.path);
        await unlink(temporary);
      } catch (error) {
        if (await existsRegular(resolved.path)) throw conflict();
        if (
          (error as NodeJS.ErrnoException).code !== 'EPERM' &&
          (error as NodeJS.ErrnoException).code !== 'ENOSYS'
        )
          throw error;
        // Some Windows hosts disable hard links. The destination was checked
        // immediately before this same-directory move; no delete-then-rename
        // fallback is used, and a racing existing destination is preserved.
        await rename(temporary, resolved.path);
      }
    } else await rename(temporary, resolved.path);
    await chmod(resolved.path, 0o600).catch(() => undefined);
    return {
      path: resolved.path,
      digest: snapshotDigest(bytes),
      bytes: bytes.byteLength,
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof SnapshotError) throw error;
    throw io();
  }
}
