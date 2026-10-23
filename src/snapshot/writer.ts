import { randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { encode, snapshotDigest } from './codec.js';
import {
  revalidateSnapshotPath,
  resolveSnapshotPath,
  sameIdentity,
  type ResolvedSnapshotPath,
} from './path.js';
import {
  SnapshotError,
  type Snapshot,
  type SnapshotWriteMode,
  type SnapshotWriteResult,
} from './types.js';

function io(): SnapshotError {
  return new SnapshotError('snapshot_io', 'The snapshot could not be written.');
}
function conflict(): SnapshotError {
  return new SnapshotError('snapshot_conflict', 'The snapshot already exists.');
}
async function ensurePrivate(file: string, directory: boolean): Promise<void> {
  const verifiesPosixMode = process.platform !== 'win32';
  const initial = await lstat(file).catch(() => {
    throw io();
  });
  if (
    initial.isSymbolicLink() ||
    (directory ? !initial.isDirectory() : !initial.isFile())
  )
    throw io();
  if (
    !verifiesPosixMode ||
    (initial.mode & 0o077) !== 0 ||
    (directory && (initial.mode & 0o700) !== 0o700) ||
    (!directory && (initial.mode & 0o600) !== 0o600)
  ) {
    // Windows exposes ACL enforcement through chmod but does not expose a
    // trustworthy POSIX mode projection through lstat; a failed chmod still
    // fails closed, while POSIX hosts additionally verify the resulting bits.
    await chmod(file, directory ? 0o700 : 0o600).catch(() => {
      throw io();
    });
  }
  const verified = await lstat(file).catch(() => {
    throw io();
  });
  if (
    verified.isSymbolicLink() ||
    (directory ? !verified.isDirectory() : !verified.isFile()) ||
    (verifiesPosixMode &&
      ((verified.mode & 0o077) !== 0 ||
        (directory && (verified.mode & 0o700) !== 0o700) ||
        (!directory && (verified.mode & 0o600) !== 0o600)))
  )
    throw io();
}

export async function writeSnapshot(
  root: string,
  snapshot: Snapshot,
  options: { readonly path?: string; readonly mode: SnapshotWriteMode },
): Promise<SnapshotWriteResult> {
  const bytes = encode(snapshot);
  let resolved: ResolvedSnapshotPath = await resolveSnapshotPath(
    root,
    options.path,
  );
  if (resolved.parentIdentity === undefined) {
    await mkdir(resolved.parent, { recursive: false, mode: 0o700 }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw io();
      },
    );
    resolved = await resolveSnapshotPath(root, options.path);
  }
  await ensurePrivate(resolved.parent, true);
  const beforeInstall = await revalidateSnapshotPath(resolved);
  if (
    resolved.destinationIdentity !== undefined &&
    (beforeInstall === undefined ||
      !sameIdentity(resolved.destinationIdentity, beforeInstall))
  )
    throw io();
  if (options.mode === 'create-only' && beforeInstall !== undefined)
    throw conflict();
  const temporary = `${resolved.path}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    let temporaryStat = await handle.stat();
    if (process.platform === 'win32' || (temporaryStat.mode & 0o077) !== 0) {
      await handle.chmod(0o600).catch(() => {
        throw io();
      });
      temporaryStat = await handle.stat();
    }
    if (
      !temporaryStat.isFile() ||
      (process.platform !== 'win32' && (temporaryStat.mode & 0o077) !== 0)
    )
      throw io();
    const temporaryIdentity = {
      dev: temporaryStat.dev,
      ino: temporaryStat.ino,
      mode: temporaryStat.mode,
      size: temporaryStat.size,
      mtimeMs: temporaryStat.mtimeMs,
    };
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const temporaryAfterClose = await lstat(temporary);
    if (
      !temporaryAfterClose.isFile() ||
      temporaryAfterClose.dev !== temporaryIdentity.dev ||
      temporaryAfterClose.ino !== temporaryIdentity.ino ||
      temporaryAfterClose.mode !== temporaryIdentity.mode
    )
      throw io();
    const installCheck = await revalidateSnapshotPath(resolved);
    if (
      resolved.destinationIdentity !== undefined &&
      (installCheck === undefined ||
        !sameIdentity(resolved.destinationIdentity, installCheck))
    )
      throw io();
    if (options.mode === 'create-only' && installCheck !== undefined)
      throw conflict();
    if (options.mode === 'create-only') {
      try {
        await link(temporary, resolved.path);
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw conflict();
        throw io();
      }
    } else await rename(temporary, resolved.path);
    await ensurePrivate(resolved.path, false);
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
