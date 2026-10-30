import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
  createCSharpExplicitProjectSelection,
} from '../src/index.js';

test('explicit C# project selection canonicalizes an unordered root-relative set', () => {
  const result = createCSharpExplicitProjectSelection([
    'src\\Zebra\\Zebra.csproj',
    'src/Alpha/Alpha.csproj',
  ]);

  assert.deepEqual(result, {
    selection: {
      version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
      kind: 'explicit-projects',
      projects: ['src/Alpha/Alpha.csproj', 'src/Zebra/Zebra.csproj'],
    },
  });
  assert.equal(Object.isFrozen(result.selection), true);
  assert.equal(Object.isFrozen(result.selection?.projects), true);
});

test('explicit C# project selection fails closed before discovery', () => {
  const tooDeep = `${Array.from({ length: 257 }, () => 'segment').join('/')}.csproj`;
  const tooLong = `src/${'a'.repeat(16 * 1024)}.csproj`;
  for (const [requested, code] of [
    [[], 'empty'],
    [['src/App/App.csproj', 'src\\App\\App.csproj'], 'duplicate'],
    [['src/Cafe\u0301/App.csproj', 'src/Café/App.csproj'], 'duplicate'],
    [['src/\uD800a.csproj', 'src/\uD801a.csproj'], 'path_invalid'],
    [['src/\uD801a.csproj', 'src/\uD800a.csproj'], 'path_invalid'],
    [['../App.csproj'], 'path_invalid'],
    [['src/App/App.fsproj'], 'project_invalid'],
    [[tooDeep], 'resource_limit'],
    [[tooLong], 'resource_limit'],
  ] as const) {
    assert.deepEqual(createCSharpExplicitProjectSelection(requested), {
      diagnostic: {
        version: CSHARP_EXPLICIT_PROJECT_SELECTION_VERSION,
        code,
      },
    });
  }
});
