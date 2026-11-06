import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MCP_TOOL_NAMES } from '../src/mcp/contracts.js';

const skill = new URL('../skills/sourcemesh/SKILL.md', import.meta.url);
const readme = new URL('../README.md', import.meta.url);
const packageJson = new URL('../package.json', import.meta.url);
const skillRevision = 'd510d70ad21f3808637d0b403d42ac0528a7f59d';
const skillUrl = `https://github.com/VissotoFlavio/source-mesh/blob/${skillRevision}/skills/sourcemesh/SKILL.md`;

test('the optional SourceMesh skill matches the MCP contract and stays unpackaged', async () => {
  const [content, publicReadme, packageContent] = await Promise.all([
    readFile(skill, 'utf8'),
    readFile(readme, 'utf8'),
    readFile(packageJson, 'utf8'),
  ]);
  const packageJsonValue = JSON.parse(packageContent) as {
    readonly files?: readonly string[];
  };

  assert.match(content, /^---\nname: sourcemesh\n/u);
  for (const tool of MCP_TOOL_NAMES)
    assert.match(content, new RegExp(`\\b${tool}\\b`, 'u'));
  assert.match(content, /search result's `id` is accepted as `nodeId`/u);
  assert.match(content, /`allowPartial` is false by default/u);
  assert.match(content, /Treat `continuation` as\s+an opaque cursor/u);
  assert.match(content, /does not configure, start, or modify the\s+server/u);
  assert.match(content, /Do not add it to a SourceMesh package/u);
  assert.equal(/[A-Za-z]:[\\/]/u.test(content), false);
  assert.equal(content.includes('E2E_SOURCE_TEXT_MARKER'), false);
  assert.equal(content.includes('E2E_SECRET_VALUE_MARKER'), false);
  assert.equal(
    packageJsonValue.files?.some(
      (entry) => entry === 'skills' || entry.startsWith('skills/'),
    ) ?? false,
    false,
  );
  assert.match(publicReadme, new RegExp(skillUrl.replaceAll('.', '\\.'), 'u'));
  assert.equal(
    publicReadme.includes('/blob/develop/skills/sourcemesh/SKILL.md'),
    false,
  );
});
