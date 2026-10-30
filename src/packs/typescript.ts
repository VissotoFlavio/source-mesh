import path from 'node:path';
import ts from 'typescript';

import { extractDeclarationGraph } from './typescript/extractor.js';
import type { DeclarationGraph } from '../graph.js';
import type {
  AnalysisRequest,
  GraphFragment,
  LanguagePack,
  LanguagePackManifest,
} from '../packs.js';

const VIRTUAL_ROOT = '/sourcemesh';
const manifest: LanguagePackManifest = {
  contractVersion: 1,
  id: 'typescript',
  version: '1.0.0',
  extensions: ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
  executionMode: 'in-process',
  capabilities: ['source-analysis', 'semantic-relations'],
};

/** A complete v1 graph is an explicit response capability of this pack. */
export interface TypeScriptGraphFragment extends GraphFragment {
  readonly graph: DeclarationGraph;
  readonly completeness: 'complete' | 'partial';
}
export interface TypeScriptLanguagePack extends LanguagePack {
  analyze(
    request: AnalysisRequest,
  ): Promise<TypeScriptGraphFragment> | TypeScriptGraphFragment;
}

const fallbackOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  checkJs: false,
  noEmit: true,
  resolveJsonModule: false,
  skipLibCheck: true,
  types: [],
  noLib: true,
};
const virtualName = (file: string) => path.posix.join(VIRTUAL_ROOT, file);

function optionsFor(configuration: AnalysisRequest['configuration']): {
  options: ts.CompilerOptions;
  valid: boolean;
} {
  const raw = configuration['typescript.tsconfig'];
  if (raw === undefined) return { options: fallbackOptions, valid: true };
  if (typeof raw !== 'string')
    return { options: fallbackOptions, valid: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      'extends' in parsed
    )
      return { options: fallbackOptions, valid: false };
    const converted = ts.convertCompilerOptionsFromJson(
      (parsed as { compilerOptions?: unknown }).compilerOptions ?? {},
      VIRTUAL_ROOT,
    );
    return converted.errors.length
      ? { options: fallbackOptions, valid: false }
      : // The pack is intentionally limited to Core-supplied source bytes. In
        // particular, configuration cannot re-enable TypeScript's host library.
        {
          options: {
            ...fallbackOptions,
            ...converted.options,
            noEmit: true,
            noLib: true,
          },
          valid: true,
        };
  } catch {
    return { options: fallbackOptions, valid: false };
  }
}

function programFor(request: AnalysisRequest): {
  program: ts.Program;
  rootNames: readonly string[];
  valid: boolean;
} {
  const configured = optionsFor(request.configuration);
  const text = new Map<string, string>();
  for (const file of request.files)
    text.set(virtualName(file.path), new TextDecoder().decode(file.contents));
  const normalized = (name: string) => path.posix.normalize(name);
  const host: ts.CompilerHost = {
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getNewLine: () => '\n',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getDefaultLibFileName: () => '',
    writeFile: () => undefined,
    fileExists: (name) => text.has(normalized(name)),
    readFile: (name) => text.get(normalized(name)),
    getSourceFile: (name, version) => {
      const source = text.get(normalized(name));
      return source === undefined
        ? undefined
        : ts.createSourceFile(name, source, version, true);
    },
    directoryExists: (name) =>
      name === VIRTUAL_ROOT ||
      [...text.keys()].some((file) => file.startsWith(`${normalized(name)}/`)),
    getDirectories: (name) => [
      ...new Set(
        [...text.keys()]
          .filter((file) => file.startsWith(`${normalized(name)}/`))
          .map((file) => path.posix.dirname(file)),
      ),
    ],
    realpath: normalized,
  };
  const rootNames = request.files.map((file) => file.path).sort();
  return {
    program: ts.createProgram(
      rootNames.map(virtualName),
      configured.options,
      host,
    ),
    rootNames,
    valid: configured.valid,
  };
}

function analyze(request: AnalysisRequest): TypeScriptGraphFragment {
  const loaded = programFor(request);
  const compilerDiagnostics = [
    ...loaded.program.getOptionsDiagnostics(),
    ...loaded.program.getSyntacticDiagnostics(),
    ...loaded.program.getSemanticDiagnostics(),
  ];
  const graph = extractDeclarationGraph({
    repositoryRoot: VIRTUAL_ROOT,
    project: {
      program: loaded.program,
      options: loaded.program.getCompilerOptions(),
      rootNames: loaded.rootNames,
    },
    repositoryName: request.repository.name,
  });
  return Object.freeze({
    pack: { id: manifest.id, version: manifest.version },
    nodes: graph.nodes
      .filter((node) => node.kind === 'file')
      .map((node) => ({
        key: node.id,
        kind: node.kind,
        path: node.path,
        name: node.name,
      })),
    edges: [],
    diagnostics: [],
    graph,
    completeness:
      loaded.valid && compilerDiagnostics.length === 0 ? 'complete' : 'partial',
  });
}

/** This API accepts no root or host: only Core-approved immutable input. */
export const typescriptPack: TypeScriptLanguagePack = Object.freeze({
  manifest: Object.freeze({
    ...manifest,
    extensions: Object.freeze([...manifest.extensions]),
    capabilities: Object.freeze([...manifest.capabilities]),
  }),
  analyze,
});
