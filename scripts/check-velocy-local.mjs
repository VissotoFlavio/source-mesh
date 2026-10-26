import process from 'node:process';

import {
  runVelocyLocalAcceptance,
  VelocyAcceptanceError,
} from '../src/csharp/velocy-profile.ts';

try {
  const result = await runVelocyLocalAcceptance(
    process.env.SM_VELOCY_ROOT,
    process.env.SM_VELOCY_CONFIRM === '1',
  );

  if (result.status === 'skipped') {
    process.stdout.write(
      'Velocy local acceptance skipped (SM_VELOCY_ROOT is not set).\n',
    );
  } else {
    process.stdout.write(
      [
        'Velocy local acceptance completed',
        `schema=${result.schemaVersion}`,
        `completeness=${result.completeness}`,
        `projects=${result.projects}`,
        `files=${result.files}`,
        `nodes=${result.nodes}`,
        `edges=${result.edges}`,
        `diagnostics=${result.diagnostics}`,
        `diagnosticCodes=${result.diagnosticCodes.join(',') || 'none'}`,
      ].join(' '),
    );
    process.stdout.write('\n');
  }
} catch (error) {
  if (error instanceof VelocyAcceptanceError) {
    process.stderr.write(
      `Velocy local acceptance failed (${error.code}${
        error.detailCodes.length === 0
          ? ''
          : `; diagnostics=${error.detailCodes.join(',')}`
      }).\n`,
    );
    process.exitCode = 1;
  } else {
    process.stderr.write('Velocy local acceptance failed (unknown_error).\n');
    process.exitCode = 1;
  }
}
