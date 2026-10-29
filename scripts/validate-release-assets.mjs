import { readFile } from 'node:fs/promises';
import process from 'node:process';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || args[index + 1] === undefined) fail('argument_missing');
  return args[index + 1];
}

function validateReleaseAssets({
  assets,
  tarballName,
  tarballDigest,
  checksumName,
  checksumDigest,
}) {
  if (!Array.isArray(assets) || assets.length !== 2) fail('asset_set_invalid');
  const expected = new Map([
    [tarballName, tarballDigest],
    [checksumName, checksumDigest],
  ]);
  if (expected.size !== 2) fail('asset_set_invalid');
  for (const asset of assets) {
    if (
      asset === null ||
      typeof asset !== 'object' ||
      typeof asset.name !== 'string' ||
      typeof asset.digest !== 'string' ||
      asset.digest !== expected.get(asset.name)
    )
      fail('asset_set_invalid');
    expected.delete(asset.name);
  }
  if (expected.size !== 0) fail('asset_set_invalid');
}

async function main() {
  const args = process.argv.slice(2);
  const release = JSON.parse(
    await readFile(option(args, '--release-json'), 'utf8').catch(() =>
      fail('release_metadata_missing'),
    ),
  );
  if (release === null || typeof release !== 'object' || Array.isArray(release))
    fail('release_metadata_invalid');
  validateReleaseAssets({
    assets: release.assets,
    tarballName: option(args, '--tarball-name'),
    tarballDigest: option(args, '--tarball-digest'),
    checksumName: option(args, '--checksum-name'),
    checksumDigest: option(args, '--checksum-digest'),
  });
}

try {
  await main();
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : 'invalid';
  process.stderr.write(`Release asset validation failed closed: ${code}.\n`);
  process.exitCode = 1;
}

export { validateReleaseAssets };
