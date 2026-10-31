import { LOCAL_WORKER_PROTOCOL_VERSION } from './local-worker.js';
import {
  LANGUAGE_PACK_CONTRACT_VERSION,
  validateLanguagePackManifest,
  type LanguagePack,
  type LanguagePackSelection,
  type PackBoundaryDiagnostic,
} from './packs.js';

/** Closed, local-only installation configuration format. */
export const LOCAL_PACK_INSTALLATION_VERSION = 1;

export interface LocalPackInstallationEntry {
  readonly id: string;
  /** Exact installed package version; ranges never resolve at analysis time. */
  readonly version: string;
  readonly enabled: boolean;
  /** Required only when the selected pack uses a local worker. */
  readonly workerProtocolVersion?: typeof LOCAL_WORKER_PROTOCOL_VERSION;
}

export interface LocalPackInstallation {
  readonly version: typeof LOCAL_PACK_INSTALLATION_VERSION;
  readonly core: {
    readonly packContractVersion: typeof LANGUAGE_PACK_CONTRACT_VERSION;
  };
  readonly packs: readonly LocalPackInstallationEntry[];
}

export type LocalPackInstallationDiagnosticCode =
  'pack_installation_invalid' | 'pack_unavailable' | 'pack_incompatible';

export interface LocalPackInstallationResult {
  /**
   * Only exact, compatible candidates supplied by the embedding application.
   * Configuration contains no module paths and this resolver never loads code.
   */
  readonly packs: readonly LanguagePack[];
  readonly selection: LanguagePackSelection;
  readonly diagnostics: readonly PackBoundaryDiagnostic[];
}

type DecodedInstallation = {
  readonly packs: readonly LocalPackInstallationEntry[];
};

const safeText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\0\r\n]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
};

function diagnostic(
  code: LocalPackInstallationDiagnosticCode,
): PackBoundaryDiagnostic {
  const message =
    code === 'pack_installation_invalid'
      ? 'Local language-pack installation configuration is invalid.'
      : code === 'pack_unavailable'
        ? 'Language pack is unavailable.'
        : 'Language pack is incompatible with the Core contract.';
  return Object.freeze({ code, severity: 'error', message });
}

function decode(value: unknown): DecodedInstallation | undefined {
  try {
    if (
      !object(value) ||
      !exactKeys(value, ['core', 'packs', 'version']) ||
      value.version !== LOCAL_PACK_INSTALLATION_VERSION ||
      !object(value.core) ||
      !exactKeys(value.core, ['packContractVersion']) ||
      value.core.packContractVersion !== LANGUAGE_PACK_CONTRACT_VERSION ||
      !Array.isArray(value.packs)
    )
      return undefined;
    const ids = new Set<string>();
    const packs: LocalPackInstallationEntry[] = [];
    for (const item of value.packs) {
      if (!object(item)) return undefined;
      const workerKeys = ['enabled', 'id', 'version', 'workerProtocolVersion'];
      const plainKeys = ['enabled', 'id', 'version'];
      if (
        (!exactKeys(item, plainKeys) && !exactKeys(item, workerKeys)) ||
        !safeText(item.id) ||
        !safeText(item.version) ||
        typeof item.enabled !== 'boolean' ||
        ids.has(item.id) ||
        (Object.hasOwn(item, 'workerProtocolVersion') &&
          item.workerProtocolVersion !== LOCAL_WORKER_PROTOCOL_VERSION)
      )
        return undefined;
      ids.add(item.id);
      packs.push(
        Object.freeze({
          id: item.id,
          version: item.version,
          enabled: item.enabled,
          ...(Object.hasOwn(item, 'workerProtocolVersion')
            ? { workerProtocolVersion: LOCAL_WORKER_PROTOCOL_VERSION }
            : {}),
        }),
      );
    }
    return Object.freeze({
      packs: Object.freeze(
        packs.sort((left, right) =>
          Buffer.from(left.id, 'utf8').compare(Buffer.from(right.id, 'utf8')),
        ),
      ),
    });
  } catch {
    return undefined;
  }
}

function manifestFor(
  candidate: LanguagePack,
): LanguagePack['manifest'] | undefined {
  try {
    validateLanguagePackManifest(candidate.manifest);
    return candidate.manifest;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a closed operator configuration against a source-owned candidate
 * list. It deliberately has no filesystem, package-manager, or module-loader
 * API, so analysis cannot fetch or execute a repository-selected pack.
 */
export function resolveLocalPackInstallation(
  configuration: unknown,
  installedPacks: readonly LanguagePack[],
): LocalPackInstallationResult {
  const installation = decode(configuration);
  if (installation === undefined)
    return Object.freeze({
      packs: Object.freeze([]),
      selection: Object.freeze({ enabledPackIds: Object.freeze([]) }),
      diagnostics: Object.freeze([diagnostic('pack_installation_invalid')]),
    });

  const accepted: LanguagePack[] = [];
  const enabledPackIds: string[] = [];
  const diagnostics: PackBoundaryDiagnostic[] = [];
  for (const entry of installation.packs) {
    const candidates = installedPacks.filter((candidate) => {
      const manifest = manifestFor(candidate);
      return manifest?.id === entry.id;
    });
    if (candidates.length === 0) {
      diagnostics.push(diagnostic('pack_unavailable'));
      continue;
    }
    const matches = candidates.filter((candidate) => {
      const manifest = manifestFor(candidate);
      return manifest?.version === entry.version;
    });
    const candidate = matches.length === 1 ? matches[0] : undefined;
    const manifest =
      candidate === undefined ? undefined : manifestFor(candidate);
    if (
      candidate === undefined ||
      manifest === undefined ||
      manifest.contractVersion !== LANGUAGE_PACK_CONTRACT_VERSION ||
      (manifest.executionMode === 'in-process' &&
        entry.workerProtocolVersion !== undefined) ||
      (manifest.executionMode !== 'in-process' &&
        entry.workerProtocolVersion !== LOCAL_WORKER_PROTOCOL_VERSION)
    ) {
      diagnostics.push(diagnostic('pack_incompatible'));
      continue;
    }
    accepted.push(candidate);
    if (entry.enabled) enabledPackIds.push(entry.id);
  }
  return Object.freeze({
    packs: Object.freeze(accepted),
    selection: Object.freeze({ enabledPackIds: Object.freeze(enabledPackIds) }),
    diagnostics: Object.freeze(diagnostics),
  });
}
