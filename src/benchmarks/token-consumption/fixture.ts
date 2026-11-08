import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function collectFiles(
  root: string,
  relative = '',
): Promise<readonly string[]> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/**
 * Hashes a fixture as sorted `relative/path=base64(bytes)` records separated by
 * LF. This is the canonical content fingerprint used by token manifests.
 */
export async function calculateTokenFixtureFingerprint(
  root: string,
): Promise<string> {
  const files = [...(await collectFiles(root))].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  const records: string[] = [];
  for (const file of files) {
    const relative = file.split(path.sep).join('/');
    const contents = await fs.readFile(path.join(root, file));
    records.push(`${relative}=${contents.toString('base64')}`);
  }
  return createHash('sha256').update(records.join('\n'), 'utf8').digest('hex');
}
