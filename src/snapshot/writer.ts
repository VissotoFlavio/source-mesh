import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises';
import { decode, encode, snapshotDigest } from './codec.js';
import {
  revalidateSnapshotPath,
  resolveSnapshotPath,
  sameIdentity,
  isVersionedSnapshotPath,
  type ResolvedSnapshotPath,
} from './path.js';
import {
  SnapshotError,
  type Snapshot,
  type SnapshotWriteResult,
} from './types.js';

interface SnapshotWriterFileSystem {
  readonly chmod: typeof chmod;
  readonly link: typeof link;
  readonly lstat: typeof lstat;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly unlink: typeof unlink;
}

const defaultFileSystem: SnapshotWriterFileSystem = {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
};

function io(): SnapshotError {
  return new SnapshotError('snapshot_io', 'The snapshot could not be written.');
}
function conflict(): SnapshotError {
  return new SnapshotError('snapshot_conflict', 'The snapshot already exists.');
}
function unsupportedCreateOnlyLink(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    platform === 'win32' &&
    (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOSYS')
  );
}
async function ensurePrivate(
  fileSystem: SnapshotWriterFileSystem,
  platform: NodeJS.Platform,
  file: string,
  directory: boolean,
): Promise<void> {
  const verifiesPosixMode = platform !== 'win32';
  const initial = await fileSystem.lstat(file).catch(() => {
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
    await fileSystem.chmod(file, directory ? 0o700 : 0o600).catch(() => {
      throw io();
    });
  }
  const verified = await fileSystem.lstat(file).catch(() => {
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
export function createSnapshotWriterForTesting(
  overrides: Partial<SnapshotWriterFileSystem> = {},
  platform: NodeJS.Platform = process.platform,
) {
  const fileSystem: SnapshotWriterFileSystem = {
    ...defaultFileSystem,
    ...overrides,
  };
  return async function writeSnapshot(
    root: string,
    snapshot: Snapshot,
    options: { readonly path: string },
  ): Promise<SnapshotWriteResult> {
    if ('mode' in options || !isVersionedSnapshotPath(options.path))
      throw new SnapshotError('path_invalid', 'The snapshot path is invalid.');
    const bytes = encode(snapshot);
    // Encoding canonicalizes the input; decoding the actual byte sequence keeps
    // publication gated on the same schema and graph invariants as bootstrap.
    decode(bytes);
    const digest = snapshotDigest(bytes);
    let resolved: ResolvedSnapshotPath = await resolveSnapshotPath(
      root,
      options.path,
    );
    if (resolved.parentIdentity === undefined) {
      const containingDirectory = path.dirname(resolved.parent);
      if (containingDirectory !== resolved.root) {
        await fileSystem
          .mkdir(containingDirectory, { recursive: false, mode: 0o700 })
          .catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw io();
          });
        // Re-resolve after each create attempt so a substituted ancestor or
        // symlink is rejected before creating the next directory.
        resolved = await resolveSnapshotPath(root, options.path);
      }
      await fileSystem
        .mkdir(resolved.parent, { recursive: false, mode: 0o700 })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw io();
        });
      resolved = await resolveSnapshotPath(root, options.path);
    }
    await ensurePrivate(fileSystem, platform, resolved.parent, true);
    const beforeInstall = await revalidateSnapshotPath(resolved);
    if (
      resolved.destinationIdentity !== undefined &&
      (beforeInstall === undefined ||
        !sameIdentity(resolved.destinationIdentity, beforeInstall))
    )
      throw io();
    if (beforeInstall !== undefined) throw conflict();
    const temporary = `${resolved.path}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await fileSystem.open(temporary, 'wx', 0o600);
      let temporaryStat = await handle.stat();
      if (platform === 'win32' || (temporaryStat.mode & 0o077) !== 0) {
        await handle.chmod(0o600).catch(() => {
          throw io();
        });
        temporaryStat = await handle.stat();
      }
      if (
        !temporaryStat.isFile() ||
        (platform !== 'win32' && (temporaryStat.mode & 0o077) !== 0)
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
      const temporaryAfterClose = await fileSystem.lstat(temporary);
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
      if (installCheck !== undefined) throw conflict();
      let fallbackPublished = false;
      {
        try {
          await fileSystem.link(temporary, resolved.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw conflict();
          if (!unsupportedCreateOnlyLink(error, platform)) throw io();
          const fallbackCheck = await revalidateSnapshotPath(resolved);
          if (
            resolved.destinationIdentity !== undefined &&
            (fallbackCheck === undefined ||
              !sameIdentity(resolved.destinationIdentity, fallbackCheck))
          )
            throw io();
          if (fallbackCheck !== undefined) throw conflict();
          let destination: Awaited<ReturnType<typeof open>> | undefined;
          try {
            destination = await fileSystem.open(resolved.path, 'wx', 0o600);
            let destinationStat = await destination.stat();
            if (platform === 'win32' || (destinationStat.mode & 0o077) !== 0) {
              await destination.chmod(0o600).catch(() => {
                throw io();
              });
              destinationStat = await destination.stat();
            }
            if (!destinationStat.isFile()) throw io();
            await destination.writeFile(bytes);
            await destination.sync();
            await destination.close();
            destination = undefined;
            await ensurePrivate(fileSystem, platform, resolved.path, false);
            await fileSystem.unlink(temporary);
            fallbackPublished = true;
          } catch (fallbackError) {
            if (destination) await destination.close().catch(() => undefined);
            // The exclusively claimed pathname may be partial. Retain it:
            // deleting by pathname could erase a concurrent replacement.
            if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST')
              throw conflict();
            throw io();
          }
        }
        if (!fallbackPublished)
          await fileSystem.unlink(temporary).catch(() => {
            throw io();
          });
      }
      if (!fallbackPublished)
        await ensurePrivate(fileSystem, platform, resolved.path, false);
      // A successful create-only install is not announced until the exact
      // destination has been observed, decoded, and tied to its digest. Check
      // its identity around the read so a detectable pathname substitution
      // fails closed.
      const beforeRead = await revalidateSnapshotPath(resolved);
      if (beforeRead === undefined) throw io();
      const publishedBytes = await readFile(resolved.path).catch(() => {
        throw io();
      });
      const afterRead = await revalidateSnapshotPath(resolved);
      if (afterRead === undefined || !sameIdentity(beforeRead, afterRead))
        throw io();
      decode(publishedBytes);
      if (
        !publishedBytes.equals(bytes) ||
        snapshotDigest(publishedBytes) !== digest
      )
        throw io();
      return {
        path: resolved.path,
        digest,
        bytes: bytes.byteLength,
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fileSystem.unlink(temporary).catch(() => undefined);
      if (error instanceof SnapshotError) throw error;
      throw io();
    }
  };
}

export const writeSnapshot = createSnapshotWriterForTesting();
