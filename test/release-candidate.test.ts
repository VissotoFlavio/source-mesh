import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const validator = path.join(
  repositoryRoot,
  'scripts',
  'validate-release-candidate.mjs',
);

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sourcemesh-release-'));
  const version = '0.1.0-beta.4';
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version, private: true }),
  );
  await fs.writeFile(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', version, packages: { '': { version } } }),
  );
  await fs.writeFile(
    path.join(root, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-10-28\n`,
  );
  return root;
}

function validate(root: string, branch = 'release/0.1.0-beta.4') {
  return spawnSync(
    process.execPath,
    [validator, '--root', root, '--branch', branch],
    {
      encoding: 'utf8',
    },
  );
}

test('release candidate validation emits a version only for coherent private metadata', async () => {
  const root = await fixture();
  try {
    const result = validate(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'version=0.1.0-beta.4\ntag=v0.1.0-beta.4\n');
    assert.equal(result.stderr, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release candidate validation fails closed for untrusted release metadata', async () => {
  const root = await fixture();
  try {
    await fs.writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.1.0-beta.3',
        packages: { '': { version: '0.1.0-beta.4' } },
      }),
    );
    const versionMismatch = validate(root);
    assert.equal(versionMismatch.status, 1);
    assert.match(versionMismatch.stderr, /version_mismatch/u);

    await fs.writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.1.0-beta.4',
        packages: { '': { version: '0.1.0-beta.4' } },
      }),
    );
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.1.0-beta.4',
        private: false,
      }),
    );
    const publicPackage = validate(root);
    assert.equal(publicPackage.status, 1);
    assert.match(publicPackage.stderr, /package_not_private/u);

    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.1.0-beta.4',
        private: true,
      }),
    );
    const invalidBranch = validate(root, 'release/0.1.0-beta.04');
    assert.equal(invalidBranch.status, 1);
    assert.match(invalidBranch.stderr, /branch_invalid/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
