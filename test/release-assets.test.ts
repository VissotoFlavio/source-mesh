import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const validator = path.join(
  repositoryRoot,
  'scripts',
  'validate-release-assets.mjs',
);
const tarballName = 'source-mesh-0.1.0-beta.4.tgz';
const checksumName = `${tarballName}.sha256`;
const tarballDigest = `sha256:${'a'.repeat(64)}`;
const checksumDigest = `sha256:${'b'.repeat(64)}`;

async function validate(
  assets: unknown,
): Promise<ReturnType<typeof spawnSync>> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sourcemesh-release-assets-'),
  );
  try {
    const releasePath = path.join(root, 'release.json');
    await fs.writeFile(releasePath, JSON.stringify({ assets }));
    return spawnSync(
      process.execPath,
      [
        validator,
        '--release-json',
        releasePath,
        '--tarball-name',
        tarballName,
        '--tarball-digest',
        tarballDigest,
        '--checksum-name',
        checksumName,
        '--checksum-digest',
        checksumDigest,
      ],
      { encoding: 'utf8' },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('existing candidate release assets must exactly match the tarball and checksum', async () => {
  const valid = await validate([
    { name: tarballName, digest: tarballDigest },
    { name: checksumName, digest: checksumDigest },
  ]);
  assert.equal(valid.status, 0);

  const unexpectedAsset = await validate([
    { name: tarballName, digest: tarballDigest },
    { name: checksumName, digest: checksumDigest },
    { name: 'unexpected.txt', digest: `sha256:${'c'.repeat(64)}` },
  ]);
  assert.equal(unexpectedAsset.status, 1);
  assert.match(String(unexpectedAsset.stderr), /asset_set_invalid/u);
});
