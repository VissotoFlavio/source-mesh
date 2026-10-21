import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  loadProject,
  PROJECT_LOADER_FALLBACK_OPTIONS,
} from '../src/project-loader.js';

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-loader-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function write(root: string, relative: string, content: string): void {
  const fileName = path.join(root, relative);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, content, 'utf8');
}

function roots(root: string): string[] {
  return fs
    .readdirSync(path.join(root, 'src'))
    .map((fileName) => `src/${fileName}`)
    .sort();
}

test('configuration-free loading uses the exact fallback and ordered approved roots', () => {
  const root = fixture();
  const extensions = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'];
  for (const extension of extensions)
    write(root, `src/file.${extension}`, 'export const value = 1;\n');

  const result = loadProject({
    repositoryRoot: root,
    approvedFiles: roots(root),
  });

  assert.ok(result.project);
  assert.deepEqual(result.project.options, PROJECT_LOADER_FALLBACK_OPTIONS);
  assert.deepEqual(result.project.rootNames, roots(root));
  assert.equal(result.project.options.allowJs, true);
  assert.equal(result.project.options.checkJs, false);
  assert.equal(result.project.options.noEmit, true);
  assert.equal(result.project.options.types?.length, 0);
  assert.equal(
    result.diagnostics.some((item) => item.path?.includes(root)),
    false,
  );
});

test('configured loading selects only approved files and honors JavaScript options', () => {
  const root = fixture();
  write(root, 'src/selected.ts', 'export const selected: number = 1;\n');
  write(root, 'src/ignored.ts', 'export const ignored: number = 1;\n');
  write(root, 'src/check.js', 'const value: string = 1;\n');
  write(
    root,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, strict: true },
      include: ['src/**/*'],
      exclude: ['src/ignored.ts'],
    }),
  );

  const result = loadProject({
    repositoryRoot: root,
    approvedFiles: ['src/check.js', 'src/ignored.ts', 'src/selected.ts'],
    tsconfigPath: 'tsconfig.json',
  });

  assert.ok(result.project);
  assert.deepEqual(result.project.rootNames, [
    'src/check.js',
    'src/selected.ts',
  ]);
  assert.equal(result.project.options.allowJs, true);
  assert.equal(result.project.options.checkJs, true);
  assert.equal(result.project.options.noEmit, true);
  assert.ok(result.diagnostics.some((item) => item.phase === 'semantic'));
});

test('invalid configuration is deterministic and does not fall back', () => {
  const root = fixture();
  write(root, 'src/index.ts', 'export const answer = 42;\n');
  write(root, 'tsconfig.json', '{ "compilerOptions": { "notAnOption": true, }');

  const request = {
    repositoryRoot: root,
    approvedFiles: ['src/index.ts'],
    tsconfigPath: 'tsconfig.json',
  };
  const first = loadProject(request);
  const second = loadProject(request);

  assert.equal(first.project, null);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.ok(
    first.diagnostics.every(
      (item) => item.message === 'Compiler configuration is invalid.',
    ),
  );
  assert.ok(first.diagnostics.every((item) => !item.message.includes(root)));
});

test('syntax diagnostics retain the program and are sanitized', () => {
  const root = fixture();
  write(root, 'src/broken.ts', 'export const broken = ;\n');

  const result = loadProject({
    repositoryRoot: root,
    approvedFiles: ['src/broken.ts'],
  });

  assert.ok(result.project);
  const syntaxDiagnostics = result.diagnostics.filter(
    (item) => item.code === 'compiler.syntax',
  );
  assert.ok(syntaxDiagnostics.length > 0);
  assert.ok(
    syntaxDiagnostics.every(
      (item) => item.message === 'Source syntax is invalid.',
    ),
  );
  assert.ok(result.diagnostics.every((item) => !item.message.includes(root)));
  assert.ok(
    result.diagnostics.every(
      (item) => !item.message.includes('export const broken'),
    ),
  );
});

test('absolute, declaration, missing, and symlink roots fail closed', () => {
  const root = fixture();
  write(root, 'src/index.ts', 'export const value = 1;\n');
  write(root, 'src/types.d.ts', 'declare const value: number;\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-outside-'));
  write(outside, 'outside.ts', 'export const outside = 1;\n');
  const link = path.join(root, 'src', 'link.ts');
  try {
    fs.symlinkSync(path.join(outside, 'outside.ts'), link, 'file');
  } catch {
    return;
  }

  const result = loadProject({
    repositoryRoot: root,
    approvedFiles: [
      path.join(root, 'src/index.ts'),
      'src/types.d.ts',
      'src/link.ts',
    ],
  });

  assert.equal(result.project, null);
  assert.ok(result.diagnostics.length > 0);
});
