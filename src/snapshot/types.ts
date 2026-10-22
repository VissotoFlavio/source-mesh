import type { DeclarationGraph } from '../graph.js';

export type SnapshotCompleteness = 'complete' | 'partial';
export type SnapshotWriteMode = 'create-only' | 'replace';

export interface SnapshotV1 extends DeclarationGraph {
  readonly schemaVersion: 1;
  readonly completeness: SnapshotCompleteness;
}

export interface SnapshotWriteRequest {
  readonly root: string;
  readonly snapshot?: SnapshotV1;
  readonly path?: string;
  readonly mode: SnapshotWriteMode;
}

export interface SnapshotLoadRequest {
  readonly root: string;
  readonly path?: string;
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
