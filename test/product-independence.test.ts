import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const prohibitedProductName = ['velo', 'cy'].join('');
const textExtensions = new Set([
  '.config',
  '.cs',
  '.csproj',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.xml',
  '.yml',
]);

async function sourceFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(candidate);
      return textExtensions.has(path.extname(entry.name).toLowerCase())
        ? [candidate]
        : [];
    }),
  );
  return nested.flat();
}

test('tracked product documentation and automation remain application-independent', async () => {
  const roots = [
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'README.md',
    'THIRD-PARTY-NOTICES.md',
    '.github',
    'docs',
    'package-lock.json',
    'package.json',
    'scripts',
    'src',
    'test',
    'tools',
  ];
  const files = (
    await Promise.all(
      roots.map(async (entry) => {
        const candidate = path.join(repository, entry);
        return path.extname(entry) === ''
          ? sourceFiles(candidate)
          : [candidate];
      }),
    )
  ).flat();

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.equal(
      content.toLowerCase().includes(prohibitedProductName),
      false,
      path.relative(repository, file),
    );
  }
});
