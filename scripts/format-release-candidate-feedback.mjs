import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const knownJobResults = new Set(['success', 'failure', 'cancelled', 'skipped']);

function jobResult(value) {
  return knownJobResults.has(value) ? value : 'unknown';
}

export function selectCandidateOutcome(input) {
  const validateResult = input.validateResult ?? input['validate-result'];
  const buildResult = input.buildResult ?? input['build-result'];
  const publishResult = input.publishResult ?? input['publish-result'];
  if (jobResult(publishResult) === 'success') return 'success';

  if (
    [validateResult, buildResult, publishResult]
      .map(jobResult)
      .includes('cancelled')
  ) {
    return 'cancelled';
  }

  if (jobResult(validateResult) !== 'success') return 'validation-failed';
  if (jobResult(buildResult) !== 'success') return 'build-failed';
  return 'publication-failed';
}

const failureMessages = {
  cancelled: 'Candidate generation was cancelled before it completed.',
  'validation-failed': 'Candidate validation did not complete successfully.',
  'build-failed': 'Candidate package build did not complete successfully.',
  'publication-failed': 'Candidate publication did not complete successfully.',
};

function required(input, name) {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required argument: --${name}.`);
  }
  return value;
}

export function formatCandidateFeedback(input) {
  const outcome = selectCandidateOutcome(input);
  const workflowUrl = required(input, 'workflow-url');

  if (outcome !== 'success') {
    return [
      '### Immutable package candidate failed',
      '',
      failureMessages[outcome],
      `- Workflow run: ${workflowUrl}`,
    ].join('\n');
  }

  return [
    '### Immutable package candidate',
    '',
    `- Version: \`${required(input, 'version')}\``,
    `- Candidate SHA: \`${required(input, 'head-sha')}\``,
    `- SHA-256: \`${required(input, 'tarball-sha256')}\``,
    `- Release: ${required(input, 'release-url')}`,
    `- Tarball: ${required(input, 'tarball-url')}`,
    `- Checksum: ${required(input, 'checksum-url')}`,
    `- Workflow run: ${workflowUrl}`,
  ].join('\n');
}

function argumentsToObject(argumentsList) {
  const output = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Expected arguments in --name value pairs.');
    }
    output[name.slice(2)] = value;
  }
  return output;
}

function main() {
  try {
    process.stdout.write(
      `${formatCandidateFeedback(argumentsToObject(process.argv.slice(2)))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Invalid arguments.'}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
