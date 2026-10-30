import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const manifest = JSON.parse(
  await readFile(
    path.join(scriptRoot, 'scripts', 'package-manifest.json'),
    'utf8',
  ),
);
const forbiddenLifecycleScripts = new Set([
  'install',
  'preinstall',
  'postinstall',
  'prepare',
]);
const csharpMcpSnapshotGuide = 'docs/csharp-mcp-snapshot-package-guide.md';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function normalizedRelative(value) {
  const normalized = value.replaceAll(path.sep, '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  )
    fail('package_path_invalid');
  return normalized;
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

async function readHelperIntegrity(helperRoot) {
  const value = JSON.parse(
    await readFile(
      path.join(helperRoot, manifest.helperIntegrityFile),
      'utf8',
    ).catch(() => fail('package_integrity_manifest_missing')),
  );
  if (
    value === null ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length !== manifest.helperFiles.length
  )
    fail('package_integrity_manifest_invalid');
  const hashes = new Map();
  for (const [index, item] of manifest.helperFiles.entries()) {
    const entry = value.files[index];
    if (
      entry === null ||
      typeof entry !== 'object' ||
      entry.path !== item.path ||
      entry.bytes !== item.bytes ||
      typeof entry.sha256 !== 'string' ||
      !/^[A-F0-9]{64}$/u.test(entry.sha256)
    )
      fail('package_integrity_manifest_invalid');
    hashes.set(item.path, entry.sha256);
  }
  return hashes;
}

async function digestPackage(root) {
  const digest = createHash('sha256');
  for (const file of (await collectFiles(root)).sort()) {
    digest.update(file);
    digest.update('\0');
    digest.update(await readFile(path.join(root, ...file.split('/'))));
    digest.update('\0');
  }
  return digest.digest('hex').toUpperCase();
}

async function assertNoSymlinkAncestors(target) {
  let current = path.resolve(target);
  while (true) {
    const stat = await lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) fail('package_symlink');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function collectFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  }).catch(() => fail('package_artifact_missing'));
  const files = [];
  for (const entry of entries) {
    const child =
      relative === '' ? entry.name : path.join(relative, entry.name);
    const normalized = normalizedRelative(child);
    if (entry.isSymbolicLink()) fail('package_symlink');
    if (entry.isDirectory()) files.push(...(await collectFiles(root, child)));
    else if (entry.isFile()) files.push(normalized);
    else fail('package_artifact_invalid');
  }
  return files;
}

async function collectDirectories(root, relative = '') {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  }).catch(() => fail('package_artifact_missing'));
  const directories = [];
  for (const entry of entries) {
    const child =
      relative === '' ? entry.name : path.join(relative, entry.name);
    const normalized = normalizedRelative(child);
    if (entry.isSymbolicLink()) fail('package_symlink');
    if (entry.isDirectory()) {
      directories.push(normalized, ...(await collectDirectories(root, child)));
    }
  }
  return directories;
}

async function verifyHelperPayload(
  helperRoot,
  { allowBuildArtifacts = false } = {},
) {
  await assertNoSymlinkAncestors(helperRoot);
  const expected = new Map(
    manifest.helperFiles.map((item) => [item.path, item]),
  );
  const integrity = await readHelperIntegrity(helperRoot);
  const expectedPayloadFiles = new Set([
    ...expected.keys(),
    manifest.helperIntegrityFile,
  ]);
  const actual = await collectFiles(helperRoot);
  const buildArtifacts = new Set([
    'sourcemesh-roslyn.exe',
    'sourcemesh-roslyn.pdb',
  ]);
  const unexpected = actual.filter(
    (file) =>
      !expectedPayloadFiles.has(file) &&
      !(allowBuildArtifacts && buildArtifacts.has(file)),
  );
  if (
    unexpected.length > 0 ||
    actual.filter((file) => expectedPayloadFiles.has(file)).length !==
      expectedPayloadFiles.size
  )
    fail('package_helper_allowlist');
  const expectedDirectories = new Set(
    manifest.helperFiles.flatMap((item) => {
      const parts = item.path.split('/');
      return parts
        .slice(0, -1)
        .map((_, index) => parts.slice(0, index + 1).join('/'));
    }),
  );
  const actualDirectories = await collectDirectories(helperRoot);
  if (
    actualDirectories.length !== expectedDirectories.size ||
    actualDirectories.some((directory) => !expectedDirectories.has(directory))
  )
    fail('package_helper_directory_allowlist');
  let total = 0;
  for (const item of manifest.helperFiles) {
    const result = await hashFile(
      path.join(helperRoot, ...item.path.split('/')),
    );
    if (
      result.bytes !== item.bytes ||
      result.sha256 !== integrity.get(item.path) ||
      (item.sha256 !== undefined && result.sha256 !== item.sha256)
    )
      fail(`package_artifact_integrity_${item.path}`);
    total += result.bytes;
  }
  if (total !== manifest.helperPayloadBytes) fail('package_payload_size');
  for (const file of [
    'sourcemesh-roslyn.deps.json',
    'sourcemesh-roslyn.runtimeconfig.json',
  ]) {
    const value = JSON.parse(
      await readFile(path.join(helperRoot, file), 'utf8').catch(() =>
        fail('package_metadata_invalid'),
      ),
    );
    const serialized = JSON.stringify(value);
    if (/(?:^|[\\/])(?:[A-Za-z]:[\\/]|[\\/])/u.test(serialized))
      fail('package_metadata_path');
  }
}

function packageNamePath(root, name) {
  return path.join(root, 'node_modules', ...name.split('/'));
}

async function verifyBundledDependencies(
  root,
  { allowExtraDependencies = false } = {},
) {
  const nodeModules = path.join(root, 'node_modules');
  const entries = await readdir(nodeModules, { withFileTypes: true }).catch(
    () => fail('bundled_dependencies_missing'),
  );
  if (!allowExtraDependencies) {
    const allowedTopLevel = new Set([
      '.bin',
      ...manifest.bundledPackages.map((item) => item.name.split('/')[0]),
    ]);
    for (const entry of entries) {
      if (!allowedTopLevel.has(entry.name)) fail('bundled_dependency_extra');
    }
    const scoped = entries.find(
      (entry) => entry.name === '@modelcontextprotocol',
    );
    if (scoped !== undefined) {
      const scopedEntries = await readdir(path.join(nodeModules, scoped.name), {
        withFileTypes: true,
      });
      const expectedScoped = new Set(
        manifest.bundledPackages
          .filter((item) => item.name.startsWith('@modelcontextprotocol/'))
          .map((item) => item.name.split('/')[1]),
      );
      for (const entry of scopedEntries) {
        if (!expectedScoped.has(entry.name)) fail('bundled_dependency_extra');
      }
    }
  }
  const lockfile = JSON.parse(
    await readFile(path.join(scriptRoot, 'package-lock.json'), 'utf8').catch(
      () => fail('bundled_lockfile_missing'),
    ),
  );
  const lockedPackages = lockfile.packages ?? {};
  for (const item of manifest.bundledPackages) {
    const packageRoot = packageNamePath(root, item.name);
    await assertNoSymlinkAncestors(packageRoot);
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8').catch(() =>
        fail('bundled_dependency_missing'),
      ),
    );
    if (
      packageJson.name !== item.name ||
      packageJson.version !== item.version ||
      packageJson.license !== item.license
    )
      fail('bundled_dependency_integrity');
    const lockEntry = lockedPackages[`node_modules/${item.name}`];
    if (
      lockEntry === undefined ||
      lockEntry.version !== item.version ||
      lockEntry.license !== item.license ||
      lockEntry.integrity !== item.integrity
    )
      fail('bundled_dependency_lock_mismatch');
    for (const script of forbiddenLifecycleScripts) {
      if (packageJson.scripts?.[script] !== undefined)
        fail('bundled_dependency_script_forbidden');
    }
    if ((await digestPackage(packageRoot)) !== item.sha256)
      fail('bundled_dependency_integrity');
  }
}

async function verifyPackageRoot(root, { installed = false } = {}) {
  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8').catch(() =>
      fail('package_metadata_missing'),
    ),
  );
  const files = [...(packageJson.files ?? [])].sort();
  const expectedFiles = [
    'THIRD-PARTY-NOTICES.md',
    csharpMcpSnapshotGuide,
    'dist',
    `${manifest.helperPath}/${manifest.helperIntegrityFile}`,
    ...manifest.helperFiles.map(
      (item) => `${manifest.helperPath}/${item.path}`,
    ),
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
    fail('package_files_invalid');
  if (
    !Array.isArray(packageJson.bundledDependencies) ||
    JSON.stringify([...packageJson.bundledDependencies].sort()) !==
      JSON.stringify([...manifest.bundledDependencies].sort())
  )
    fail('bundled_dependencies_invalid');
  if (installed) {
    const allowedRootEntries = new Set([
      'dist',
      'docs',
      'tools',
      'node_modules',
      'package.json',
      'README.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
    ]);
    const rootEntries = await readdir(root, { withFileTypes: true }).catch(() =>
      fail('package_root_missing'),
    );
    for (const entry of rootEntries) {
      if (entry.isSymbolicLink() || !allowedRootEntries.has(entry.name))
        fail('package_root_allowlist');
    }
  }
  for (const script of forbiddenLifecycleScripts) {
    if (packageJson.scripts?.[script] !== undefined)
      fail('install_script_forbidden');
  }
  const readme = await readFile(path.join(root, 'README.md'), 'utf8').catch(
    () => fail('package_readme_missing'),
  );
  if (!readme.includes(`](${csharpMcpSnapshotGuide})`))
    fail('package_csharp_guide_unlinked');
  const guide = await readFile(
    path.join(root, ...csharpMcpSnapshotGuide.split('/')),
    'utf8',
  ).catch(() => fail('package_csharp_guide_missing'));
  const normalizedGuide = guide.replace(/\s+/gu, ' ');
  for (const phrase of [
    'Generate the snapshot before configuring or starting MCP.',
    'exactly one repository-relative selector',
    'UTF-8 is the normal source policy.',
    'maximum of 4096 compiler diagnostics',
  ]) {
    if (!normalizedGuide.includes(phrase)) fail('package_csharp_guide_invalid');
  }
  if (
    /[A-Za-z]:[\\/]/u.test(guide) ||
    guide.includes('E2E_SOURCE_TEXT_MARKER') ||
    guide.includes('E2E_SECRET_VALUE_MARKER')
  )
    fail('package_csharp_guide_invalid');
  const notice = await readFile(
    path.join(root, 'THIRD-PARTY-NOTICES.md'),
    'utf8',
  ).catch(() => fail('third_party_notice_missing'));
  for (const item of manifest.bundledPackages) {
    if (!notice.includes(item.name) || !notice.includes(item.version))
      fail('third_party_notice_incomplete');
  }
  for (const phrase of [
    'Microsoft.CodeAnalysis.CSharp',
    'Microsoft.CodeAnalysis.Common',
    'Microsoft.CodeAnalysis.Analyzers',
    '.NET Foundation',
    'Humanizer',
    'Inflector',
    'ByteSize',
  ]) {
    if (!notice.includes(phrase)) fail('third_party_notice_incomplete');
  }
  await verifyHelperPayload(
    path.join(root, ...manifest.helperPath.split('/')),
    {
      allowBuildArtifacts: !installed,
    },
  );
  await verifyBundledDependencies(root, { allowExtraDependencies: !installed });
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const helperIndex = args.indexOf('--helper-root');
  const root = rootIndex >= 0 ? args[rootIndex + 1] : scriptRoot;
  if (root === undefined) fail('package_root_missing');
  if (helperIndex >= 0) {
    const helperRoot = args[helperIndex + 1];
    if (helperRoot === undefined) fail('package_root_missing');
    await verifyHelperPayload(path.resolve(helperRoot));
  } else {
    await verifyPackageRoot(path.resolve(root), {
      installed: args.includes('--installed'),
    });
  }
}

try {
  await main();
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : 'invalid';
  process.stderr.write(`Package validation failed closed: ${code}.\n`);
  process.exitCode = 1;
}

export { verifyHelperPayload, verifyPackageRoot };
