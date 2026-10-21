import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { discoverSourceFiles } from '../src/discovery.js';

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sourcemesh-discovery-'));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
});

describe('discoverSourceFiles', () => {
  it('returns deterministic portable source paths and the canonical root', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'z.js'), '');
    await writeFile(path.join(root, 'a.ts'), '');
    await writeFile(path.join(root, 'nested.tsx'), '');
    const result = await discoverSourceFiles(root);

    assert.equal(result.repositoryRoot, await realpath(root));
    assert.deepEqual(result.sources, ['a.ts', 'nested.tsx', 'z.js']);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(await discoverSourceFiles(root), result);
  });

  it('applies exact extensions, declaration exclusions, reserved directories, and secrets', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'ok.mts'), '');
    await writeFile(path.join(root, 'ok.cjs'), '');
    await writeFile(path.join(root, 'types.d.ts'), '');
    await writeFile(path.join(root, 'notes.txt'), '');
    await writeFile(path.join(root, '.env.ts'), '');
    await writeFile(path.join(root, 'token.key'), '');
    for (const directory of [
      '.git',
      'node_modules',
      'dist',
      'generated',
      '.sourcemesh',
    ]) {
      await mkdir(path.join(root, directory));
      await writeFile(path.join(root, directory, 'ignored.ts'), '');
    }

    const result = await discoverSourceFiles(root);
    assert.deepEqual(result.sources, ['ok.cjs', 'ok.mts']);
  });

  it('skips dangling and contained/outside symlinks without traversing them', async (t) => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(path.join(root, 'real.ts'), '');
    await writeFile(path.join(outside, 'escape.ts'), '');
    try {
      await symlink(path.join(root, 'real.ts'), path.join(root, 'inside.ts'));
      await symlink(
        path.join(outside, 'escape.ts'),
        path.join(root, 'outside.ts'),
      );
      await symlink(
        path.join(root, 'missing.ts'),
        path.join(root, 'dangling.ts'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('symlink fixtures are unavailable on this host');
        return;
      }
      throw error;
    }

    const result = await discoverSourceFiles(root);
    assert.deepEqual(result.sources, ['real.ts']);
    assert.deepEqual(
      result.diagnostics.map(({ path: itemPath, reason }) => [
        itemPath,
        reason,
      ]),
      [
        ['dangling.ts', 'symlink_skipped'],
        ['inside.ts', 'symlink_skipped'],
        ['outside.ts', 'symlink_skipped'],
      ],
    );
  });

  it('rejects invalid roots with sanitized diagnostics', async () => {
    const root = await fixture();
    const file = path.join(root, 'file.ts');
    await writeFile(file, '');
    assert.deepEqual(
      (await discoverSourceFiles(path.join(root, 'missing'))).diagnostics,
      [
        {
          code: 'path_invalid',
          severity: 'error',
          message: 'Repository-relative path is invalid.',
          reason: 'root_missing',
        },
      ],
    );
    assert.deepEqual((await discoverSourceFiles(file)).diagnostics, [
      {
        code: 'path_invalid',
        severity: 'error',
        message: 'Repository-relative path is invalid.',
        reason: 'root_not_directory',
      },
    ]);
  });
});
