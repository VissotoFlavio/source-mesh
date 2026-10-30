import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const formatter = path.join(
  repositoryRoot,
  'scripts',
  'format-release-candidate-feedback.mjs',
);
const workflowUrl =
  'https://github.com/VissotoFlavio/source-mesh/actions/runs/42';

function formatFeedback(argumentsList: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [formatter, ...argumentsList], {
    encoding: 'utf8',
  });
}

test('formats the complete success feedback for a validated candidate', () => {
  const result = formatFeedback([
    '--validate-result',
    'success',
    '--build-result',
    'success',
    '--publish-result',
    'success',
    '--version',
    '0.1.0-beta.6',
    '--head-sha',
    'a'.repeat(40),
    '--tarball-sha256',
    'b'.repeat(64),
    '--release-url',
    'https://github.com/VissotoFlavio/source-mesh/releases/tag/v0.1.0-beta.6',
    '--tarball-url',
    'https://github.com/VissotoFlavio/source-mesh/releases/download/v0.1.0-beta.6/source-mesh-0.1.0-beta.6.tgz',
    '--checksum-url',
    'https://github.com/VissotoFlavio/source-mesh/releases/download/v0.1.0-beta.6/source-mesh-0.1.0-beta.6.tgz.sha256',
    '--workflow-url',
    workflowUrl,
  ]);
  assert.equal(result.status, 0);
  const comment = String(result.stdout);

  assert.match(comment, /Version: `0\.1\.0-beta\.6`/u);
  assert.match(comment, new RegExp(`Candidate SHA: \`${'a'.repeat(40)}\``));
  assert.match(comment, new RegExp(`SHA-256: \`${'b'.repeat(64)}\``));
  assert.match(comment, /releases\/tag\/v0\.1\.0-beta\.6/u);
  assert.match(comment, /source-mesh-0\.1\.0-beta\.6\.tgz$/mu);
  assert.match(comment, /source-mesh-0\.1\.0-beta\.6\.tgz\.sha256/u);
  assert.match(comment, new RegExp(workflowUrl));
});

test('selects a concise sanitized failure outcome from job results', () => {
  const result = formatFeedback([
    '--validate-result',
    'failure',
    '--build-result',
    'skipped',
    '--publish-result',
    'skipped',
    '--workflow-url',
    workflowUrl,
    '--version',
    'untrusted-value',
  ]);
  assert.equal(result.status, 0);
  const comment = String(result.stdout).trimEnd();
  assert.equal(
    comment,
    [
      '### Immutable package candidate failed',
      '',
      'Candidate validation did not complete successfully.',
      `- Workflow run: ${workflowUrl}`,
    ].join('\n'),
  );
});

test('a successful publication remains successful when earlier job values are malformed', () => {
  const result = formatFeedback([
    '--validate-result',
    'unexpected stderr or token',
    '--build-result',
    'failure',
    '--publish-result',
    'success',
    '--version',
    '0.1.0-beta.6',
    '--head-sha',
    'a'.repeat(40),
    '--tarball-sha256',
    'b'.repeat(64),
    '--release-url',
    'https://example.test/release',
    '--tarball-url',
    'https://example.test/tarball',
    '--checksum-url',
    'https://example.test/checksum',
    '--workflow-url',
    workflowUrl,
  ]);
  assert.equal(result.status, 0);
  assert.match(String(result.stdout), /### Immutable package candidate$/mu);
});
