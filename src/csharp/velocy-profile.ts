import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverCSharpManifest } from './discovery.js';
import {
  analyzeCSharpManifest,
  CSharpWorkerError,
  type CSharpWorkerResult,
} from './worker.js';
import { extractCSharpDeclarationGraph } from './extractor.js';
import { isRemoteRoot } from '../discovery.js';
import { writeSnapshot } from '../snapshot/writer.js';
import { SnapshotError } from '../snapshot/types.js';
import type { SnapshotV2 } from '../snapshot/types.js';
import type {
  CSharpDiscoverySelection,
  CSharpManifest,
  CSharpManifestResult,
} from './contracts.js';

export const VELOCY_SOLUTION_PATH = 'src/Velocy.API.sln';
export const VELOCY_SNAPSHOT_PATH = '.sourcemesh/velocy-api.json';

export type VelocyAcceptanceFailureCode =
  | 'confirmation_required'
  | 'root_invalid'
  | 'root_missing'
  | 'root_not_directory'
  | 'root_unreadable'
  | 'preflight_failed'
  | 'analysis_failed'
  | 'snapshot_conflict'
  | 'snapshot_failed';

export class VelocyAcceptanceError extends Error {
  constructor(
    readonly code: VelocyAcceptanceFailureCode,
    readonly detailCodes: readonly string[] = [],
  ) {
    super('The Velocy local acceptance profile could not complete.');
    this.name = 'VelocyAcceptanceError';
  }
}

export interface VelocyAcceptanceSummary {
  readonly status: 'completed';
  readonly schemaVersion: 2;
  readonly completeness: SnapshotV2['completeness'];
  readonly projects: number;
  readonly files: number;
  readonly nodes: number;
  readonly edges: number;
  readonly diagnostics: number;
  readonly diagnosticCodes: readonly string[];
}

export interface VelocyAcceptanceSkipped {
  readonly status: 'skipped';
}

export interface VelocyAcceptanceServices {
  readonly discoverCSharpManifest: typeof discoverCSharpManifest;
  readonly analyzeCSharpManifest: typeof analyzeCSharpManifest;
  readonly extractCSharpDeclarationGraph: typeof extractCSharpDeclarationGraph;
  readonly writeSnapshot: typeof writeSnapshot;
}

const productionServices: VelocyAcceptanceServices = {
  discoverCSharpManifest,
  analyzeCSharpManifest,
  extractCSharpDeclarationGraph,
  writeSnapshot,
};

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function fail(
  code: VelocyAcceptanceFailureCode,
  detailCodes: readonly string[] = [],
): never {
  throw new VelocyAcceptanceError(code, sortedUnique(detailCodes));
}

async function canonicalLocalRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root) || isRemoteRoot(root)) fail('root_invalid');

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch {
    fail('root_missing');
  }

  try {
    const stats = await fs.stat(canonicalRoot);
    if (!stats.isDirectory()) fail('root_not_directory');
  } catch (error) {
    if (error instanceof VelocyAcceptanceError) throw error;
    fail('root_unreadable');
  }
  return canonicalRoot;
}

function manifestFailure(result: CSharpManifestResult): never {
  fail(
    'preflight_failed',
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );
}

function analysisFailure(error: unknown): never {
  if (error instanceof CSharpWorkerError) fail('analysis_failed', [error.code]);
  fail('analysis_failed');
}

function snapshotFailure(error: unknown): never {
  if (error instanceof SnapshotError) {
    if (error.code === 'snapshot_conflict') fail('snapshot_conflict');
    fail('snapshot_failed', [error.code]);
  }
  fail('snapshot_failed');
}

export async function runVelocyLocalAcceptance(
  root: string | undefined,
  confirmed: boolean,
  services: VelocyAcceptanceServices = productionServices,
): Promise<VelocyAcceptanceSummary | VelocyAcceptanceSkipped> {
  if (root === undefined) return { status: 'skipped' };
  if (!confirmed) fail('confirmation_required');

  const repositoryRoot = await canonicalLocalRoot(root);
  const selection: CSharpDiscoverySelection = {
    solution: VELOCY_SOLUTION_PATH,
  };
  let manifestResult: CSharpManifestResult;
  try {
    manifestResult = await services.discoverCSharpManifest(
      repositoryRoot,
      selection,
    );
  } catch {
    fail('preflight_failed');
  }
  if (
    manifestResult.manifest === undefined ||
    manifestResult.diagnostics.length
  )
    manifestFailure(manifestResult);

  const manifest: CSharpManifest = manifestResult.manifest;
  let worker: CSharpWorkerResult;
  try {
    worker = await services.analyzeCSharpManifest(repositoryRoot, manifest);
  } catch (error) {
    analysisFailure(error);
  }

  let snapshot: SnapshotV2;
  try {
    snapshot = services.extractCSharpDeclarationGraph({
      repositoryRoot,
      manifest,
      worker,
    });
  } catch {
    fail('analysis_failed');
  }

  try {
    await services.writeSnapshot(repositoryRoot, snapshot, {
      path: VELOCY_SNAPSHOT_PATH,
      mode: 'create-only',
    });
  } catch (error) {
    snapshotFailure(error);
  }

  const diagnosticCodes = sortedUnique([
    ...worker.diagnostics.map((diagnostic) => diagnostic.code),
    ...snapshot.diagnostics.map((diagnostic) => diagnostic.code),
  ]);
  return {
    status: 'completed',
    schemaVersion: snapshot.schemaVersion,
    completeness: snapshot.completeness,
    projects: manifest.projects.length,
    files: manifest.projects.reduce(
      (total, project) => total + project.files.length,
      0,
    ),
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    diagnostics: worker.diagnostics.length + snapshot.diagnostics.length,
    diagnosticCodes,
  };
}
