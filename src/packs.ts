export const LANGUAGE_PACK_CONTRACT_VERSION = 1;

export type LanguagePackExecutionMode =
  'in-process' | 'local-worker' | 'hybrid';
export type LanguagePackCapability =
  'source-analysis' | 'project-manifest' | 'semantic-relations';
export type RelationConfidence = 'semantic' | 'syntactic' | 'inferred';
export type PackDiagnosticCode =
  'pack_response_invalid' | 'pack_not_registered' | 'pack_request_invalid';

export interface LanguagePackManifest {
  readonly contractVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly extensions: readonly string[];
  readonly executionMode: LanguagePackExecutionMode;
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

export function validateLanguagePackManifest(
  manifest: LanguagePackManifest,
): void {
  if (
    manifest.contractVersion !== LANGUAGE_PACK_CONTRACT_VERSION ||
    !safeText(manifest.id) ||
    !safeText(manifest.version) ||
    !modes.has(manifest.executionMode) ||
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

function normalized(fragment: GraphFragment): GraphFragment {
  return Object.freeze({
    pack: Object.freeze({ ...fragment.pack }),
    nodes: Object.freeze(
      [...fragment.nodes].sort((left, right) => ordinal(left.key, right.key)),
    ),
    edges: Object.freeze(
      [...fragment.edges].sort(
        (left, right) =>
          ordinal(left.kind, right.kind) ||
          ordinal(left.from, right.from) ||
          ordinal(left.to, right.to),
      ),
    ),
    diagnostics: Object.freeze(
      [...fragment.diagnostics].sort(
        (left, right) =>
          ordinal(left.code, right.code) ||
          ordinal(left.path ?? '', right.path ?? ''),
      ),
    ),
  });
}

export class LanguagePackRegistry {
  readonly #packs = new Map<string, LanguagePack>();

  register(pack: LanguagePack): void {
    validateLanguagePackManifest(pack.manifest);
    if (this.#packs.has(pack.manifest.id))
      throw new TypeError('Language pack is already registered.');
    this.#packs.set(pack.manifest.id, pack);
  }

  async analyze(
    id: string,
    request: AnalysisRequest,
  ): Promise<PackAnalysisResult> {
    const pack = this.#packs.get(id);
    if (pack === undefined)
      return failure('pack_not_registered', 'Language pack is not registered.');
    if (!validRequest(request))
      return failure(
        'pack_request_invalid',
        'Language pack request is invalid.',
      );
    try {
      const fragment = await pack.analyze(request);
      return validFragment(fragment, pack.manifest, request)
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
