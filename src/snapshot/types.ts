import type {
  DeclarationGraph,
  DeclarationGraphV2,
  DeclarationGraphV3,
} from '../graph.js';

export type SnapshotCompleteness = 'complete' | 'partial';

export interface SnapshotV1 extends DeclarationGraph {
  readonly schemaVersion: 1;
  readonly completeness: SnapshotCompleteness;
}
export interface SnapshotV2 extends DeclarationGraphV2 {
  readonly schemaVersion: 2;
  readonly completeness: SnapshotCompleteness;
}
export type SnapshotPackCapability =
  'source-analysis' | 'project-manifest' | 'semantic-relations';

/**
 * A local pack that contributed graph elements to a schema-v3 snapshot.
 *
 * This is descriptive provenance supplied by the snapshot producer; it is
 * not an authenticity or integrity assertion.
 */
export interface SnapshotPackMetadata {
  readonly id: string;
  readonly language: string;
  readonly version: string;
  readonly capabilities: readonly SnapshotPackCapability[];
}
export interface SnapshotMetadataV3 {
  /** Schema-v3 provenance is descriptive and deliberately unverified. */
  readonly verification: 'unverified';
  readonly packs: readonly SnapshotPackMetadata[];
}
export interface SnapshotV3 extends DeclarationGraphV3 {
  readonly schemaVersion: 3;
  readonly completeness: SnapshotCompleteness;
  readonly metadata: SnapshotMetadataV3;
}
export type Snapshot = SnapshotV1 | SnapshotV2 | SnapshotV3;

export interface SnapshotWriteRequest {
  readonly root: string;
  readonly snapshot: Snapshot;
  readonly path: string;
}

export interface SnapshotLoadRequest {
  readonly root: string;
  readonly path: string;
}

export type SnapshotErrorCode =
  | 'invalid_snapshot'
  | 'unsupported_schema'
  | 'path_invalid'
  | 'snapshot_conflict'
  | 'snapshot_io'
  | 'missing_snapshot';

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  readonly observedVersion: number | undefined;
  readonly supportedVersions: readonly number[] | undefined;

  constructor(
    code: SnapshotErrorCode,
    message: string,
    options?: {
      observedVersion?: number;
      supportedVersions?: readonly number[];
    },
  ) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.observedVersion = options?.observedVersion;
    this.supportedVersions = options?.supportedVersions;
  }
}

export interface SnapshotWriteResult {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
}
