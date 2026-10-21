import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SOURCE_MESH_NAME } from '../src/index.js';

test('exports the SourceMesh application name', () => {
  assert.equal(SOURCE_MESH_NAME, 'SourceMesh');
});
