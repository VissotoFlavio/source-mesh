import path from 'node:path';

import { LOCAL_WORKER_PROTOCOL_VERSION } from './local-worker.js';

import {
  discoverSourceFiles,
  type DiscoverSourceFilesOptions,
  type DiscoveryResult,
} from './discovery.js';

export const LANGUAGE_PACK_CONTRACT_VERSION = 1;

export type LanguagePackExecutionMode =
  'in-process' | 'local-worker' | 'hybrid';
export type LanguagePackCapability =
  'source-analysis' | 'project-manifest' | 'semantic-relations';
export type RelationConfidence = 'semantic' | 'syntactic' | 'inferred';
export type PackDiagnosticCode =
  | 'pack_response_invalid'
  | 'pack_not_registered'
  | 'pack_request_invalid'
  | 'pack_disabled'
  | 'pack_already_registered'
  | 'pack_unsupported_extension'
  | 'pack_duplicate_extension'
  | 'pack_unavailable'
  | 'pack_incompatible'
  | 'pack_installation_invalid'
  | 'pack_selection_ambiguous';

export interface LanguagePackManifest {
  readonly contractVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly extensions: readonly string[];
  readonly executionMode: LanguagePackExecutionMode;
  /** Required for packs that can invoke the fixed local-worker protocol. */
  readonly workerProtocolVersion?: typeof LOCAL_WORKER_PROTOCOL_VERSION;
  readonly capabilities: readonly LanguagePackCapability[];
}

export interface ApprovedFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

export interface AnalysisLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxDiagnostics: number;
}

export interface AnalysisRequest {
  readonly contractVersion: 1;
  readonly repository: { readonly name: string; readonly root: '.' };
  readonly files: readonly ApprovedFile[];
  readonly limits: AnalysisLimits;
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
}

export interface PackNode {
  readonly key: string;
  readonly kind: string;
  readonly path: string;
  readonly name: string;
}
export interface PackEdge {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly confidence: RelationConfidence;
}
export interface PackDiagnostic {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly path?: string;
}
export interface GraphFragment {
  readonly pack: { readonly id: string; readonly version: string };
  readonly nodes: readonly PackNode[];
  readonly edges: readonly PackEdge[];
  readonly diagnostics: readonly PackDiagnostic[];
}
export interface LanguagePack {
  readonly manifest: LanguagePackManifest;
  analyze(request: AnalysisRequest): Promise<GraphFragment> | GraphFragment;
}
export interface PackBoundaryDiagnostic {
  readonly code: PackDiagnosticCode;
  readonly severity: 'error';
  readonly message: string;
}
export interface PackAnalysisResult {
  readonly fragment?: GraphFragment;
  readonly diagnostics: readonly PackBoundaryDiagnostic[];
}

/** The static, local list of packs that may participate in one analysis. */
export interface LanguagePackSelection {
  readonly enabledPackIds: readonly string[];
  /** Resolves a shared extension to exactly one enabled local pack. */
  readonly extensionOwners?: Readonly<Record<string, string>>;
}

export interface PackExtensionOwner {
  readonly extension: string;
  readonly packId: string;
}

/**
 * The closed discovery input derived from enabled local pack manifests. No
 * repository metadata, package lookup, or remote state participates here.
 */
export interface PackDiscoveryPlan {
  readonly extensions: readonly string[];
  readonly owners: readonly PackExtensionOwner[];
  readonly diagnostics: readonly PackBoundaryDiagnostic[];
}

export interface PackFileDispatch {
  readonly path: string;
  readonly packId: string;
}

export interface PackDispatchResult {
  readonly dispatch?: PackFileDispatch;
  readonly diagnostics: readonly PackBoundaryDiagnostic[];
}

export interface EnabledPackDiscoveryResult {
  readonly discovery?: DiscoveryResult;
  readonly dispatches: readonly PackFileDispatch[];
  readonly diagnostics: readonly PackBoundaryDiagnostic[];
}

export interface PackRegistrationResult {
  readonly diagnostics: readonly PackBoundaryDiagnostic[];
}

interface StoredLanguagePackSelection {
  readonly enabledPackIds: readonly string[];
  readonly extensionOwners: ReadonlyMap<string, string>;
}

interface RegisteredLanguagePack {
  readonly manifest: LanguagePackManifest;
  readonly analyze: LanguagePack['analyze'];
}

const INVALID_SELECTION = Symbol('invalid-language-pack-selection');

const modes = new Set<LanguagePackExecutionMode>([
  'in-process',
  'local-worker',
  'hybrid',
]);
const capabilities = new Set<LanguagePackCapability>([
  'source-analysis',
  'project-manifest',
  'semantic-relations',
]);
const confidence = new Set<RelationConfidence>([
  'semantic',
  'syntactic',
  'inferred',
]);
const extension = /^\.[a-z0-9]+$/u;
const safeText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\0\r\n]/u.test(value);
const safePath = (value: unknown): value is string =>
  safeText(value) &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  !/^[A-Za-z]:/u.test(value) &&
  !value
    .split('/')
    .some((part) => part === '' || part === '.' || part === '..');
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const ordinal = (left: string, right: string) =>
  Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
const failure = (
  code: PackDiagnosticCode,
  message: string,
): PackAnalysisResult => ({
  diagnostics: Object.freeze([{ code, severity: 'error', message }]),
});
const diagnostic = (
  code: PackDiagnosticCode,
  message: string,
): PackBoundaryDiagnostic => ({ code, severity: 'error', message });
const diagnostics = (
  ...items: readonly PackBoundaryDiagnostic[]
): readonly PackBoundaryDiagnostic[] =>
  Object.freeze(
    [...items].sort(
      (left, right) =>
        ordinal(left.code, right.code) || ordinal(left.message, right.message),
    ),
  );

function storedSelection(
  value: unknown,
): StoredLanguagePackSelection | typeof INVALID_SELECTION {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return INVALID_SELECTION;
    const selection = value as Partial<LanguagePackSelection>;
    if (
      !Array.isArray(selection.enabledPackIds) ||
      !selection.enabledPackIds.every(safeText)
    )
      return INVALID_SELECTION;
    const ownerConfiguration = selection.extensionOwners;
    if (ownerConfiguration === undefined)
      return Object.freeze({
        enabledPackIds: Object.freeze([...selection.enabledPackIds]),
        extensionOwners: new Map(),
      });
    if (
      typeof ownerConfiguration !== 'object' ||
      ownerConfiguration === null ||
      Array.isArray(ownerConfiguration)
    )
      return INVALID_SELECTION;
    const prototype = Object.getPrototypeOf(ownerConfiguration);
    if (prototype !== Object.prototype && prototype !== null)
      return INVALID_SELECTION;
    const entries = Object.entries(ownerConfiguration);
    if (
      !entries.every(
        ([extensionName, packId]) =>
          extension.test(extensionName) && safeText(packId),
      )
    )
      return INVALID_SELECTION;
    return Object.freeze({
      enabledPackIds: Object.freeze([...selection.enabledPackIds]),
      extensionOwners: new Map(entries),
    });
  } catch {
    return INVALID_SELECTION;
  }
}

function snapshotManifest(
  manifest: LanguagePackManifest,
): LanguagePackManifest {
  const snapshot: LanguagePackManifest = {
    contractVersion: manifest.contractVersion,
    id: manifest.id,
    version: manifest.version,
    extensions: [...manifest.extensions],
    executionMode: manifest.executionMode,
    ...(manifest.workerProtocolVersion === undefined
      ? {}
      : { workerProtocolVersion: manifest.workerProtocolVersion }),
    capabilities: [...manifest.capabilities],
  };
  validateLanguagePackManifest(snapshot);
  return Object.freeze({
    ...snapshot,
    extensions: Object.freeze([...snapshot.extensions]),
    capabilities: Object.freeze([...snapshot.capabilities]),
  });
}

export function validateLanguagePackManifest(
  manifest: LanguagePackManifest,
): void {
  if (
    manifest.contractVersion !== LANGUAGE_PACK_CONTRACT_VERSION ||
    !safeText(manifest.id) ||
    !safeText(manifest.version) ||
    !modes.has(manifest.executionMode) ||
    ((manifest.executionMode === 'local-worker' ||
      manifest.executionMode === 'hybrid') &&
      manifest.workerProtocolVersion !== LOCAL_WORKER_PROTOCOL_VERSION) ||
    (manifest.executionMode === 'in-process' &&
      manifest.workerProtocolVersion !== undefined) ||
    manifest.extensions.length === 0 ||
    !manifest.extensions.every((item) => extension.test(item)) ||
    new Set(manifest.extensions).size !== manifest.extensions.length ||
    !manifest.capabilities.every((item) => capabilities.has(item)) ||
    new Set(manifest.capabilities).size !== manifest.capabilities.length
  )
    throw new TypeError('Language pack manifest is invalid.');
}

function validRequest(request: AnalysisRequest): boolean {
  const limits = request.limits;
  return (
    request.contractVersion === LANGUAGE_PACK_CONTRACT_VERSION &&
    request.repository.root === '.' &&
    safeText(request.repository.name) &&
    positive(limits.maxFiles) &&
    positive(limits.maxBytes) &&
    positive(limits.maxNodes) &&
    positive(limits.maxEdges) &&
    positive(limits.maxDiagnostics) &&
    request.files.length <= limits.maxFiles &&
    request.files.every(
      (file) => safePath(file.path) && file.contents instanceof Uint8Array,
    ) &&
    new Set(request.files.map((file) => file.path)).size ===
      request.files.length &&
    request.files.reduce(
      (total, file) => total + file.contents.byteLength,
      0,
    ) <= limits.maxBytes &&
    Object.entries(request.configuration).every(
      ([key, value]) =>
        safeText(key) &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'),
    )
  );
}

function immutableRequest(request: AnalysisRequest): AnalysisRequest {
  return Object.freeze({
    contractVersion: request.contractVersion,
    repository: Object.freeze({ ...request.repository }),
    files: Object.freeze(
      request.files.map((file) =>
        Object.freeze({
          path: file.path,
          contents: new Uint8Array(file.contents),
        }),
      ),
    ),
    limits: Object.freeze({ ...request.limits }),
    configuration: Object.freeze({ ...request.configuration }),
  });
}

function validFragment(
  value: GraphFragment,
  manifest: LanguagePackManifest,
  request: AnalysisRequest,
): value is GraphFragment {
  const paths = new Set(request.files.map((file) => file.path));
  const keys = new Set(value.nodes.map((node) => node.key));
  return (
    value.pack.id === manifest.id &&
    value.pack.version === manifest.version &&
    value.nodes.length <= request.limits.maxNodes &&
    value.edges.length <= request.limits.maxEdges &&
    value.diagnostics.length <= request.limits.maxDiagnostics &&
    value.nodes.every(
      (node) =>
        safeText(node.key) &&
        safeText(node.kind) &&
        safeText(node.name) &&
        paths.has(node.path),
    ) &&
    keys.size === value.nodes.length &&
    value.edges.every(
      (edge) =>
        safeText(edge.kind) &&
        keys.has(edge.from) &&
        keys.has(edge.to) &&
        confidence.has(edge.confidence),
    ) &&
    value.diagnostics.every(
      (diagnostic) =>
        safeText(diagnostic.code) &&
        (diagnostic.severity === 'warning' ||
          diagnostic.severity === 'error') &&
        (diagnostic.path === undefined || paths.has(diagnostic.path)),
    )
  );
}

function snapshotFragment(fragment: GraphFragment): GraphFragment {
  const pack = fragment.pack;
  const nodes = fragment.nodes;
  const edges = fragment.edges;
  const diagnostics = fragment.diagnostics;
  return Object.freeze({
    pack: Object.freeze({ id: pack.id, version: pack.version }),
    nodes: Object.freeze(
      nodes.map((node) =>
        Object.freeze({
          key: node.key,
          kind: node.kind,
          path: node.path,
          name: node.name,
        }),
      ),
    ),
    edges: Object.freeze(
      edges.map((edge) =>
        Object.freeze({
          kind: edge.kind,
          from: edge.from,
          to: edge.to,
          confidence: edge.confidence,
        }),
      ),
    ),
    diagnostics: Object.freeze(
      diagnostics.map((diagnostic) => {
        const path = diagnostic.path;
        return Object.freeze({
          code: diagnostic.code,
          severity: diagnostic.severity,
          ...(path === undefined ? {} : { path }),
        });
      }),
    ),
  });
}

function normalized(fragment: GraphFragment): GraphFragment {
  return Object.freeze({
    pack: Object.freeze({ ...fragment.pack }),
    nodes: Object.freeze(
      fragment.nodes
        .map((node) => Object.freeze({ ...node }))
        .sort((left, right) => ordinal(left.key, right.key)),
    ),
    edges: Object.freeze(
      fragment.edges
        .map((edge) => Object.freeze({ ...edge }))
        .sort(
          (left, right) =>
            ordinal(left.kind, right.kind) ||
            ordinal(left.from, right.from) ||
            ordinal(left.to, right.to),
        ),
    ),
    diagnostics: Object.freeze(
      fragment.diagnostics
        .map((diagnostic) => Object.freeze({ ...diagnostic }))
        .sort(
          (left, right) =>
            ordinal(left.code, right.code) ||
            ordinal(left.path ?? '', right.path ?? ''),
        ),
    ),
  });
}

export class LanguagePackRegistry {
  readonly #packs = new Map<string, RegisteredLanguagePack>();
  readonly #incompatiblePackIds = new Set<string>();
  #selection:
    StoredLanguagePackSelection | typeof INVALID_SELECTION | undefined;

  register(pack: LanguagePack): void {
    const manifest = snapshotManifest(pack.manifest);
    this.#store(manifest, pack.analyze);
  }

  #store(
    manifest: LanguagePackManifest,
    analyze: LanguagePack['analyze'],
  ): void {
    if (this.#packs.has(manifest.id))
      throw new TypeError('Language pack is already registered.');
    this.#incompatiblePackIds.delete(manifest.id);
    this.#packs.set(manifest.id, Object.freeze({ manifest, analyze }));
  }

  /**
   * Records a compatible, preinstalled pack without allowing an invalid local
   * candidate to escape as an exception or trigger any lookup.
   */
  registerCandidate(candidate: unknown): PackRegistrationResult {
    let id: unknown;
    try {
      const pack = candidate as Partial<LanguagePack> | undefined;
      const candidateManifest = pack?.manifest;
      id = candidateManifest?.id;
      if (typeof pack?.analyze !== 'function') throw new TypeError();
      const manifest = snapshotManifest(
        candidateManifest as LanguagePackManifest,
      );
      if (this.#packs.has(manifest.id))
        return {
          diagnostics: diagnostics(
            diagnostic(
              'pack_already_registered',
              'Language pack is already registered.',
            ),
          ),
        };
      this.#store(manifest, pack.analyze);
      return { diagnostics: Object.freeze([]) };
    } catch {
      if (safeText(id) && !this.#packs.has(id))
        this.#incompatiblePackIds.add(id);
      return {
        diagnostics: diagnostics(
          diagnostic(
            'pack_incompatible',
            'Language pack is incompatible with the Core contract.',
          ),
        ),
      };
    }
  }

  /**
   * Sets the explicit local enablement list and optional ownership choices.
   * A caller must choose an owner for every extension shared by enabled packs.
   */
  configure(selection: LanguagePackSelection): PackDiscoveryPlan {
    this.#selection = storedSelection(selection);
    return this.discoveryPlan();
  }

  /** Returns the deterministic extension union and its unique local owners. */
  discoveryPlan(): PackDiscoveryPlan {
    const selection = this.#selection;
    if (selection === undefined || selection === INVALID_SELECTION)
      return Object.freeze({
        extensions: Object.freeze([]),
        owners: Object.freeze([]),
        diagnostics: diagnostics(
          diagnostic(
            'pack_selection_ambiguous',
            'Language pack selection is ambiguous.',
          ),
        ),
      });
    const enabledIds = selection?.enabledPackIds ?? [...this.#packs.keys()];
    const configuredOwners = selection?.extensionOwners ?? new Map();
    const items: PackBoundaryDiagnostic[] = [];
    const requested = new Set<string>();

    for (const id of enabledIds) {
      if (!safeText(id) || requested.has(id)) {
        items.push(
          diagnostic(
            'pack_selection_ambiguous',
            'Language pack selection is ambiguous.',
          ),
        );
        continue;
      }
      requested.add(id);
      if (this.#incompatiblePackIds.has(id)) {
        items.push(
          diagnostic(
            'pack_incompatible',
            'Language pack is incompatible with the Core contract.',
          ),
        );
      } else if (!this.#packs.has(id)) {
        items.push(
          diagnostic('pack_unavailable', 'Language pack is unavailable.'),
        );
      }
    }

    const enabled = [...requested]
      .map((id) => this.#packs.get(id))
      .filter((pack): pack is RegisteredLanguagePack => pack !== undefined)
      .sort((left, right) => ordinal(left.manifest.id, right.manifest.id));
    const candidates = new Map<string, RegisteredLanguagePack[]>();
    for (const pack of enabled) {
      for (const extensionName of pack.manifest.extensions) {
        const owners = candidates.get(extensionName) ?? [];
        owners.push(pack);
        candidates.set(extensionName, owners);
      }
    }

    for (const [extensionName, packId] of configuredOwners) {
      const candidatesForExtension = candidates.get(extensionName) ?? [];
      if (
        candidatesForExtension.length === 0 ||
        !candidatesForExtension.some((pack) => pack.manifest.id === packId)
      )
        items.push(
          diagnostic(
            'pack_selection_ambiguous',
            'Language pack selection is ambiguous.',
          ),
        );
    }

    const owners: PackExtensionOwner[] = [];
    for (const extensionName of [...candidates.keys()].sort(ordinal)) {
      const candidatesForExtension = candidates.get(extensionName)!;
      if (candidatesForExtension.length === 1) {
        owners.push({
          extension: extensionName,
          packId: candidatesForExtension[0]!.manifest.id,
        });
        continue;
      }
      const ownerId = configuredOwners.get(extensionName);
      const owner = candidatesForExtension.find(
        (pack) => pack.manifest.id === ownerId,
      );
      if (owner === undefined) {
        items.push(
          diagnostic(
            'pack_duplicate_extension',
            'Language pack extension ownership must be configured explicitly.',
          ),
        );
        continue;
      }
      owners.push({ extension: extensionName, packId: owner.manifest.id });
    }

    return Object.freeze({
      extensions: Object.freeze(owners.map((owner) => owner.extension)),
      owners: Object.freeze(owners.map((owner) => Object.freeze(owner))),
      diagnostics: diagnostics(...items),
    });
  }

  /** Resolves one approved repository-relative path to exactly one pack. */
  dispatch(filePath: string): PackDispatchResult {
    const plan = this.discoveryPlan();
    if (plan.diagnostics.length > 0) return { diagnostics: plan.diagnostics };
    const extensionName = path.posix.extname(filePath).toLowerCase();
    const owner = plan.owners.find(
      (candidate) => candidate.extension === extensionName,
    );
    return owner === undefined
      ? {
          diagnostics: diagnostics(
            diagnostic(
              'pack_unsupported_extension',
              'Source file extension is not supported by an enabled language pack.',
            ),
          ),
        }
      : {
          dispatch: Object.freeze({ path: filePath, packId: owner.packId }),
          diagnostics: Object.freeze([]),
        };
  }

  /**
   * Discovers only the union of enabled, uniquely owned extensions and then
   * dispatches each approved file to that single local owner.
   */
  async discover(
    selectedRoot: string,
    options: Omit<DiscoverSourceFilesOptions, 'extensions'> = {},
  ): Promise<EnabledPackDiscoveryResult> {
    const plan = this.discoveryPlan();
    if (plan.diagnostics.length > 0)
      return {
        dispatches: Object.freeze([]),
        diagnostics: plan.diagnostics,
      };
    if (plan.extensions.length === 0)
      return {
        dispatches: Object.freeze([]),
        diagnostics: Object.freeze([]),
      };
    const discovery = await discoverSourceFiles(selectedRoot, {
      ...options,
      extensions: plan.extensions,
    });
    const dispatches: PackFileDispatch[] = [];
    const items: PackBoundaryDiagnostic[] = [];
    for (const source of discovery.sources) {
      const result = this.dispatch(source);
      if (result.dispatch !== undefined) dispatches.push(result.dispatch);
      items.push(...result.diagnostics);
    }
    return {
      discovery,
      dispatches: Object.freeze(dispatches),
      diagnostics: diagnostics(...items),
    };
  }

  async analyze(
    id: string,
    request: AnalysisRequest,
  ): Promise<PackAnalysisResult> {
    const plan = this.discoveryPlan();
    if (plan.diagnostics.length > 0) return { diagnostics: plan.diagnostics };
    const pack = this.#packs.get(id);
    if (pack === undefined)
      return failure('pack_not_registered', 'Language pack is not registered.');
    if (
      this.#selection !== undefined &&
      this.#selection !== INVALID_SELECTION &&
      !this.#selection.enabledPackIds.includes(id)
    )
      return failure(
        'pack_disabled',
        'Language pack is disabled for this analysis.',
      );
    if (!validRequest(request))
      return failure(
        'pack_request_invalid',
        'Language pack request is invalid.',
      );
    try {
      const approvedRequest = immutableRequest(request);
      const fragment = snapshotFragment(await pack.analyze(approvedRequest));
      return validFragment(fragment, pack.manifest, approvedRequest)
        ? { fragment: normalized(fragment), diagnostics: Object.freeze([]) }
        : failure(
            'pack_response_invalid',
            'Language pack response is invalid.',
          );
    } catch {
      return failure(
        'pack_response_invalid',
        'Language pack response is invalid.',
      );
    }
  }
}
