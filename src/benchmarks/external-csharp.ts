import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createCSharpExplicitProjectSelection,
  type CSharpExplicitProjectSelection,
} from '../packs/csharp/contracts.js';
import { discoverCSharpExplicitProjectManifest } from '../packs/csharp/discovery.js';

export interface ExternalCSharpSelection {
  readonly targetRoot: string;
  readonly projects: readonly string[];
}

export interface StagedExternalCSharpProject {
  readonly root: string;
  readonly projects: readonly string[];
  cleanup(): Promise<void>;
}

function invalidSelection(reason = 'invalid_selection'): Error {
  return new Error(`The external C# selection is invalid (${reason}).`);
}

async function copyRegularFile(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
): Promise<void> {
  const source = path.join(sourceRoot, relativePath);
  const details = await lstat(source);
  if (!details.isFile() || details.isSymbolicLink()) throw invalidSelection();
  const destination = path.join(destinationRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function embeddedResources(
  sourceRoot: string,
  projectPath: string,
): Promise<readonly string[]> {
  const projectSource = await readFile(
    path.join(sourceRoot, projectPath),
    'utf8',
  );
  const resources: string[] = [];
  for (const tag of projectSource.matchAll(/<EmbeddedResource\s+[^>]*>/gu)) {
    const include = /\bInclude\s*=\s*"([^"]+)"/u.exec(tag[0])?.[1];
    if (include === undefined) continue;
    const absolute = path.resolve(
      sourceRoot,
      path.dirname(projectPath),
      include,
    );
    const relative = path.relative(sourceRoot, absolute);
    if (
      relative === '' ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes('..')
    )
      throw invalidSelection();
    resources.push(relative.replaceAll(path.sep, '/'));
  }
  return resources;
}

/**
 * Builds a disposable, source-only copy of one explicit C# selection. It uses
 * the same discovery boundary as analysis, then copies approved `.cs`,
 * `.csproj`, and explicitly declared embedded-resource files. No target
 * repository path is ever used as an output path.
 */
export async function stageExternalCSharpProject(
  selectionInput: ExternalCSharpSelection,
): Promise<StagedExternalCSharpProject> {
  if (!path.isAbsolute(selectionInput.targetRoot)) throw invalidSelection();
  const sourceRoot = await realpath(selectionInput.targetRoot);
  const selectionResult = createCSharpExplicitProjectSelection(
    selectionInput.projects,
  );
  if (selectionResult.selection === undefined)
    throw invalidSelection(selectionResult.diagnostic.code);
  const selection: CSharpExplicitProjectSelection = selectionResult.selection;
  const discovered = await discoverCSharpExplicitProjectManifest(
    sourceRoot,
    selection,
  );
  if (discovered.manifest === undefined)
    throw invalidSelection(
      discovered.diagnostics.map((item) => item.code).join(',') || 'failed',
    );
  const stagedRoot = await mkdtemp(
    path.join(os.tmpdir(), 'sourcemesh-external-csharp-'),
  );
  try {
    const approved = new Set<string>();
    for (const project of discovered.manifest.projects) {
      approved.add(project.path);
      for (const reference of project.references) approved.add(reference);
      for (const file of project.files) approved.add(file);
      for (const resource of await embeddedResources(sourceRoot, project.path))
        approved.add(resource);
    }
    for (const relativePath of [...approved].sort())
      await copyRegularFile(sourceRoot, stagedRoot, relativePath);
    return {
      root: stagedRoot,
      projects: selection.projects,
      cleanup: async () => rm(stagedRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(stagedRoot, { recursive: true, force: true });
    throw error;
  }
}
