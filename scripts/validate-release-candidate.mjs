import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

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

function parseJson(value, code) {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      fail(code);
    return parsed;
  } catch (error) {
    if (error && typeof error === 'object' && error.code !== undefined)
      throw error;
    fail(code);
  }
}

function candidateVersion(branch) {
  if (!branch.startsWith('release/')) fail('branch_invalid');
  const version = branch.slice('release/'.length);
  if (version.length === 0 || version.includes('/') || !semver.test(version))
    fail('branch_invalid');
  return version;
}

function hasCandidateHeading(changelog, version) {
  const heading = `## [${version}] - `;
  return (
    changelog
      .split(/\r?\n/u)
      .filter((line) => /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/u.test(line))
      .filter((line) => line.startsWith(heading)).length === 1
  );
}

async function validateReleaseCandidate({
  branch,
  packageJsonPath,
  packageLockPath,
  changelogPath,
}) {
  const version = candidateVersion(branch);
  const [packageJsonText, packageLockText, changelog] = await Promise.all([
    readFile(packageJsonPath, 'utf8').catch(() => fail('package_json_missing')),
    readFile(packageLockPath, 'utf8').catch(() => fail('package_lock_missing')),
    readFile(changelogPath, 'utf8').catch(() => fail('changelog_missing')),
  ]);
  const packageJson = parseJson(packageJsonText, 'package_json_invalid');
  const packageLock = parseJson(packageLockText, 'package_lock_invalid');
  const lockRoot = packageLock.packages;

  if (
    typeof packageJson.version !== 'string' ||
    typeof packageLock.version !== 'string' ||
    lockRoot === null ||
    typeof lockRoot !== 'object' ||
    Array.isArray(lockRoot) ||
    lockRoot[''] === null ||
    typeof lockRoot[''] !== 'object' ||
    Array.isArray(lockRoot['']) ||
    typeof lockRoot[''].version !== 'string' ||
    packageJson.version !== version ||
    packageLock.version !== version ||
    lockRoot[''].version !== version
  )
    fail('version_mismatch');
  if (packageJson.private !== true) fail('package_not_private');
  if (!hasCandidateHeading(changelog, version))
    fail('changelog_heading_missing');

  return { version, tag: `v${version}` };
}

async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(option(args, '--root'));
  const result = await validateReleaseCandidate({
    branch: option(args, '--branch'),
    packageJsonPath: path.join(root, 'package.json'),
    packageLockPath: path.join(root, 'package-lock.json'),
    changelogPath: path.join(root, 'CHANGELOG.md'),
  });
  process.stdout.write(`version=${result.version}\ntag=${result.tag}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : 'invalid';
    process.stderr.write(
      `Release candidate validation failed closed: ${code}.\n`,
    );
    process.exitCode = 1;
  }
}

export { validateReleaseCandidate };
