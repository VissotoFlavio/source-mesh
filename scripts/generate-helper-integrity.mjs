import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const manifest = JSON.parse(
  await readFile(
    path.join(repository, 'scripts', 'package-manifest.json'),
    'utf8',
  ),
);
const helperRoot = path.join(repository, ...manifest.helperPath.split('/'));

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function hashFile(file) {
  const bytes = await readFile(file).catch(() =>
    fail('package_artifact_missing'),
  );
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  };
}

const files = [];
for (const item of manifest.helperFiles) {
  const result = await hashFile(path.join(helperRoot, ...item.path.split('/')));
  if (result.bytes !== item.bytes) fail(`package_artifact_size_${item.path}`);
  if (item.sha256 !== undefined && result.sha256 !== item.sha256)
    fail(`package_artifact_integrity_${item.path}`);
  files.push({ path: item.path, ...result });
}

await writeFile(
  path.join(helperRoot, manifest.helperIntegrityFile),
  `${JSON.stringify({ version: 1, files })}\n`,
  'utf8',
);
