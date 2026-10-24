import path from 'node:path';
import {
  createDefaultDiscoveryFileSystem,
  discoverSourceFiles,
  hasReservedDirectory,
  isContainedPath,
  isRemoteRoot,
  isSecretFile,
  isWindowsUnsafePath,
  normalizeRelativePath,
  isSerializedPathTooLong,
  MAX_DIRECTORY_ENTRIES,
  MAX_PATH_DEPTH,
  pathDepth,
  pathIdentityKey,
  resolveRepositoryPath,
  toRepositoryPath,
  type DiscoveryFileSystem,
} from '../discovery.js';
import {
  CSHARP_MAX_AGGREGATE_XML_BYTES,
  CSHARP_MAX_AGGREGATE_READ_BYTES,
  CSHARP_MAX_EXPLICIT_COMPILE_ITEMS,
  CSHARP_MAX_EXPLICIT_INCLUDE_READS,
  CSHARP_MAX_EXPLICIT_OPERATIONS,
  CSHARP_MAX_PROJECT_FILES,
  CSHARP_MAX_PROJECT_REFERENCES,
  CSHARP_MAX_PROJECTS,
  CSHARP_MAX_READ_OPERATIONS,
  CSHARP_MAX_SOLUTION_PROJECTS,
  CSHARP_MAX_SOURCE_BYTES,
  CSHARP_MAX_XML_ATTRIBUTES_PER_NODE,
  CSHARP_MAX_XML_DEPTH,
  CSHARP_MAX_XML_NODES,
  CSHARP_MAX_XML_TEXT_ATTRIBUTE_BYTES,
  CSHARP_MAX_XML_BYTES,
  type CSharpDiscoveryDiagnostic,
  type CSharpDiscoverySelection,
  type CSharpManifest,
  type CSharpManifestResult,
  type CSharpProjectManifest,
  type CSharpSelectionKind,
  type CSharpSolutionManifest,
  type DiscoverCSharpManifestOptions,
} from './contracts.js';
import type { DiscoveryStats } from '../discovery.js';

interface XmlNode {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
  readonly text: string;
}

class CSharpFailure extends Error {
  readonly code: CSharpDiscoveryDiagnostic['code'];
  readonly relativePath: string | undefined;

  constructor(code: CSharpDiscoveryDiagnostic['code'], relativePath?: string) {
    super('C# project discovery could not be completed.');
    this.name = 'CSharpFailure';
    this.code = code;
    this.relativePath = relativePath;
  }
}

function ordinal(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function diagnostic(
  code: CSharpDiscoveryDiagnostic['code'],
  relativePath?: string,
): CSharpDiscoveryDiagnostic {
  const messages: Record<CSharpDiscoveryDiagnostic['code'], string> = {
    invalid_selection: 'The C# selection is invalid.',
    path_invalid: 'The selected C# path is invalid.',
    xml_invalid: 'The project metadata is invalid.',
    unsupported_construct:
      'The project metadata contains an unsupported construct.',
    io_error: 'The project metadata could not be read.',
    resource_limit: 'The C# discovery resource limit was exceeded.',
  };
  return Object.freeze({
    code,
    severity: 'error' as const,
    message: messages[code],
    ...(relativePath === undefined ? {} : { path: relativePath }),
  });
}

function failureResult(
  code: CSharpDiscoveryDiagnostic['code'],
  relativePath?: string,
): CSharpManifestResult {
  return Object.freeze({
    diagnostics: freezeArray([diagnostic(code, relativePath)]),
  });
}

function isProjectPath(value: string): boolean {
  return value.toLowerCase().endsWith('.csproj');
}

function isSolutionPath(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.endsWith('.sln') || lower.endsWith('.slnx');
}

function joinRelative(directory: string, child: string): string {
  return directory === '' ? child : `${directory}/${child}`;
}

function projectDirectory(relativeProject: string): string {
  const directory = path.posix.dirname(relativeProject);
  return directory === '.' ? '' : directory;
}

function assertPathBudget(value: string, relativePath: string): void {
  if (isPathOverBudget(value))
    throw new CSharpFailure('resource_limit', relativePath);
}

function isPathOverBudget(value: string): boolean {
  return isSerializedPathTooLong(value) || pathDepth(value) > MAX_PATH_DEPTH;
}

function canonicalRelativePath(
  root: string,
  candidate: string,
): string | undefined {
  const relative = path.relative(root, candidate);
  if (relative === '') return '.';
  const portable = toRepositoryPath(root, candidate);
  if (portable === undefined) return undefined;
  assertPathBudget(portable, portable);
  return portable;
}

function isAllowedXmlCharacter(value: number): boolean {
  return (
    value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

function isAllowedXmlText(
  value: string,
  rejectCDataTerminator = false,
): boolean {
  return (
    [...value].every((character) =>
      isAllowedXmlCharacter(character.codePointAt(0)!),
    ) &&
    !value.includes('&') &&
    (!rejectCDataTerminator || !value.includes(']]>'))
  );
}

function hasMsBuildExpression(value: string): boolean {
  return value.includes('$(') || value.includes('@(') || value.includes('%(');
}

function isXmlWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function trimXmlWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isXmlWhitespace(value[start])) start += 1;
  while (end > start && isXmlWhitespace(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function isXmlNameStart(value: string): boolean {
  return /[A-Za-z_]/u.test(value);
}

function isXmlNamePart(value: string): boolean {
  return /[A-Za-z0-9_.:-]/u.test(value);
}

function isXmlDeclaration(value: string): boolean {
  return /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(['"])1\.[01]\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(['"])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(['"])(?:yes|no)\3)?[ \t\r\n]*\?>$/u.test(
    value,
  );
}

function parseXml(source: string): XmlNode {
  if (!isAllowedXmlText(source)) throw new CSharpFailure('xml_invalid');
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: Array<{
    readonly name: string;
    readonly attributes: Map<string, string>;
    readonly children: XmlNode[];
    text: string;
  }> = [];
  let root: XmlNode | undefined;
  let nodeCount = 0;
  let textAttributeBytes = 0;

  const consumeTextOrAttribute = (value: string): void => {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (textAttributeBytes > CSHARP_MAX_XML_TEXT_ATTRIBUTE_BYTES - bytes)
      throw new CSharpFailure('resource_limit');
    textAttributeBytes += bytes;
  };

  const registerElement = (): void => {
    if (
      nodeCount >= CSHARP_MAX_XML_NODES ||
      stack.length + 1 > CSHARP_MAX_XML_DEPTH
    )
      throw new CSharpFailure('resource_limit');
    nodeCount += 1;
  };

  const appendText = (value: string): void => {
    if (!isAllowedXmlText(value, true)) throw new CSharpFailure('xml_invalid');
    consumeTextOrAttribute(value);
    if (stack.length > 0) stack[stack.length - 1]!.text += value;
    else if (trimXmlWhitespace(value) !== '')
      throw new CSharpFailure('xml_invalid');
  };

  const close = (name: string): void => {
    const current = stack.pop();
    if (current === undefined || current.name !== name)
      throw new CSharpFailure('xml_invalid');
    const node: XmlNode = {
      name: current.name,
      attributes: new Map(current.attributes),
      children: freezeArray(current.children),
      text: current.text,
    };
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
    else if (root === undefined) root = node;
    else throw new CSharpFailure('xml_invalid');
  };

  while (offset < source.length) {
    const open = source.indexOf('<', offset);
    if (open < 0) {
      appendText(source.slice(offset));
      break;
    }
    appendText(source.slice(offset, open));
    offset = open;
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4);
      if (end < 0) throw new CSharpFailure('xml_invalid');
      const comment = source.slice(offset + 4, end);
      if (comment.includes('--') || comment.endsWith('-'))
        throw new CSharpFailure('xml_invalid');
      offset = end + 3;
      continue;
    }
    if (source.startsWith('<?xml', offset)) {
      if (offset !== (source.charCodeAt(0) === 0xfeff ? 1 : 0))
        throw new CSharpFailure('xml_invalid');
      const end = source.indexOf('?>', offset + 5);
      if (end < 0) throw new CSharpFailure('xml_invalid');
      if (!isXmlDeclaration(source.slice(offset, end + 2)))
        throw new CSharpFailure('xml_invalid');
      offset = end + 2;
      continue;
    }
    if (source.startsWith('<?', offset) || source.startsWith('<!', offset))
      throw new CSharpFailure('unsupported_construct');

    offset += 1;
    const closing = source[offset] === '/';
    if (closing) offset += 1;
    const nameStart = offset;
    if (!isXmlNameStart(source[offset] ?? ''))
      throw new CSharpFailure('xml_invalid');
    offset += 1;
    while (offset < source.length && isXmlNamePart(source[offset]!))
      offset += 1;
    const name = source.slice(nameStart, offset);
    if (closing) {
      while (isXmlWhitespace(source[offset])) offset += 1;
      if (source[offset] !== '>') throw new CSharpFailure('xml_invalid');
      offset += 1;
      close(name);
      continue;
    }

    const attributes = new Map<string, string>();
    while (offset < source.length) {
      while (isXmlWhitespace(source[offset])) offset += 1;
      if (source.startsWith('/>', offset)) {
        offset += 2;
        registerElement();
        stack.push({ name, attributes, children: [], text: '' });
        close(name);
        break;
      }
      if (source[offset] === '>') {
        offset += 1;
        registerElement();
        stack.push({ name, attributes, children: [], text: '' });
        break;
      }
      const attributeStart = offset;
      if (!isXmlNameStart(source[offset] ?? ''))
        throw new CSharpFailure('xml_invalid');
      offset += 1;
      while (offset < source.length && isXmlNamePart(source[offset]!))
        offset += 1;
      const attribute = source.slice(attributeStart, offset);
      if (attributes.has(attribute)) throw new CSharpFailure('xml_invalid');
      while (isXmlWhitespace(source[offset])) offset += 1;
      if (source[offset] !== '=') throw new CSharpFailure('xml_invalid');
      offset += 1;
      while (isXmlWhitespace(source[offset])) offset += 1;
      const quote = source[offset];
      if (quote !== '"' && quote !== "'")
        throw new CSharpFailure('xml_invalid');
      offset += 1;
      const valueStart = offset;
      const valueEnd = source.indexOf(quote, offset);
      if (valueEnd < 0) throw new CSharpFailure('xml_invalid');
      const value = source.slice(valueStart, valueEnd);
      if (!isAllowedXmlText(value) || value.includes('<'))
        throw new CSharpFailure('xml_invalid');
      if (hasMsBuildExpression(value))
        throw new CSharpFailure('unsupported_construct');
      if (attributes.size >= CSHARP_MAX_XML_ATTRIBUTES_PER_NODE)
        throw new CSharpFailure('resource_limit');
      consumeTextOrAttribute(attribute);
      consumeTextOrAttribute(value);
      attributes.set(attribute, value);
      offset = valueEnd + 1;
    }
    if (offset >= source.length && source[source.length - 1] !== '>')
      throw new CSharpFailure('xml_invalid');
  }
  if (stack.length !== 0 || root === undefined)
    throw new CSharpFailure('xml_invalid');
  return root;
}

function assertAttributes(node: XmlNode, allowed: readonly string[]): void {
  for (const attribute of node.attributes.keys()) {
    if (!allowed.includes(attribute))
      throw new CSharpFailure('unsupported_construct');
  }
}

function leafText(node: XmlNode): string {
  if (node.children.length > 0 || trimXmlWhitespace(node.text) === '')
    throw new CSharpFailure('unsupported_construct');
  const value = trimXmlWhitespace(node.text).normalize('NFC');
  if (hasMsBuildExpression(value))
    throw new CSharpFailure('unsupported_construct');
  return value;
}

interface ParsedProject {
  readonly targetFramework?: string;
  readonly langVersion?: string;
  readonly references: readonly string[];
  readonly compile: readonly CompileOperation[];
}

interface CompileOperation {
  readonly kind: 'include' | 'remove';
  readonly value: string;
}

function parseProjectXml(source: string): ParsedProject {
  const root = parseXml(source);
  if (root.name !== 'Project') throw new CSharpFailure('unsupported_construct');
  assertAttributes(root, ['Sdk']);
  if (trimXmlWhitespace(root.text) !== '')
    throw new CSharpFailure('unsupported_construct');
  const references: string[] = [];
  const compile: CompileOperation[] = [];
  let targetFramework: string | undefined;
  let langVersion: string | undefined;
  for (const group of root.children) {
    if (group.name !== 'PropertyGroup' && group.name !== 'ItemGroup')
      throw new CSharpFailure('unsupported_construct');
    assertAttributes(group, []);
    for (const child of group.children) {
      if (group.name === 'PropertyGroup') {
        if (child.name !== 'TargetFramework' && child.name !== 'LangVersion')
          throw new CSharpFailure('unsupported_construct');
        assertAttributes(child, []);
        const value = leafText(child);
        if (child.name === 'TargetFramework') {
          if (targetFramework !== undefined)
            throw new CSharpFailure('unsupported_construct');
          targetFramework = value;
        } else {
          if (langVersion !== undefined)
            throw new CSharpFailure('unsupported_construct');
          langVersion = value;
        }
        continue;
      }
      if (child.name === 'ProjectReference') {
        assertAttributes(child, ['Include']);
        if (
          child.attributes.size !== 1 ||
          child.children.length > 0 ||
          trimXmlWhitespace(child.text) !== ''
        )
          throw new CSharpFailure('unsupported_construct');
        references.push(child.attributes.get('Include')!);
      } else if (child.name === 'Compile') {
        assertAttributes(child, ['Include', 'Remove']);
        if (
          child.attributes.size !== 1 ||
          child.children.length > 0 ||
          trimXmlWhitespace(child.text) !== ''
        )
          throw new CSharpFailure('unsupported_construct');
        const include = child.attributes.get('Include');
        const remove = child.attributes.get('Remove');
        if (include !== undefined)
          compile.push({ kind: 'include', value: include });
        else if (remove !== undefined)
          compile.push({ kind: 'remove', value: remove });
      } else {
        throw new CSharpFailure('unsupported_construct');
      }
    }
  }
  return {
    ...(targetFramework === undefined ? {} : { targetFramework }),
    ...(langVersion === undefined ? {} : { langVersion }),
    references,
    compile,
  };
}

function parseSolutionText(source: string): readonly string[] {
  const projects: string[] = [];
  for (const line of source.split(/\r?\n/u)) {
    if (!/^Project\(/u.test(line)) continue;
    const match =
      /^Project\("[^"]+"\)\s*=\s*"[^"]*",\s*"([^"]+)",\s*"\{[^"\r\n]+\}"\s*$/u.exec(
        line,
      );
    if (match === null) throw new CSharpFailure('xml_invalid');
    const projectPath = match[1]!;
    if (path.posix.extname(projectPath).length === 0) continue;
    if (!isProjectPath(projectPath))
      throw new CSharpFailure('unsupported_construct');
    projects.push(projectPath);
  }
  if (projects.length === 0) throw new CSharpFailure('invalid_selection');
  return freezeArray(projects);
}

function parseSolutionXml(source: string): readonly string[] {
  const root = parseXml(source);
  if (root.name !== 'Solution')
    throw new CSharpFailure('unsupported_construct');
  const projects: string[] = [];
  const visit = (node: XmlNode): void => {
    if (node.name === 'Project') {
      assertAttributes(node, ['Path']);
      if (
        node.attributes.size !== 1 ||
        node.children.length > 0 ||
        trimXmlWhitespace(node.text) !== ''
      )
        throw new CSharpFailure('unsupported_construct');
      const projectPath = node.attributes.get('Path')!;
      if (!isProjectPath(projectPath))
        throw new CSharpFailure('unsupported_construct');
      projects.push(projectPath);
      return;
    }
    if (node.name !== 'Solution' && node.name !== 'Folder')
      throw new CSharpFailure('unsupported_construct');
    assertAttributes(node, node.name === 'Folder' ? ['Name'] : []);
    if (trimXmlWhitespace(node.text) !== '')
      throw new CSharpFailure('unsupported_construct');
    for (const child of node.children) visit(child);
  };
  visit(root);
  if (projects.length === 0) throw new CSharpFailure('invalid_selection');
  return freezeArray(projects);
}

interface DiscoveryState {
  readonly root: string;
  readonly rootIdentity: DiscoveryStats;
  readonly filesystem: DiscoveryFileSystem;
  aggregateXmlBytes: number;
  aggregateReadBytes: number;
  readOperations: number;
  directoryEntries: number;
  projectCount: number;
  fileCount: number;
  explicitIncludeReads: number;
  explicitOperations: number;
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number; readonly size: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number },
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.size === right.size
  );
}

function sameEntryIdentity(
  left: {
    readonly dev: number;
    readonly ino: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
  right: {
    readonly dev: number;
    readonly ino: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

/**
 * Node does not expose a portable openat-style ancestor walk. We therefore
 * validate every ancestor before and after each read, reject all observed
 * aliases, and let the bounded descriptor read fail closed on replacement.
 */
async function validateContainedPath(
  state: DiscoveryState,
  relativePath: string,
  kind: 'file' | 'directory',
): Promise<{
  readonly absolute: string;
  readonly canonicalPath: string;
  readonly identity: DiscoveryStats;
  readonly ancestors: readonly {
    readonly canonicalPath: string;
    readonly identity: DiscoveryStats;
  }[];
}> {
  const absolute = resolveRepositoryPath(state.root, relativePath);
  const isRoot = relativePath === '.';
  if (!isRoot && !isContainedPath(state.root, absolute))
    throw new CSharpFailure('path_invalid', relativePath);
  const rootCanonical = await state.filesystem.realpath(state.root);
  const rootIdentity = await state.filesystem.lstat(state.root);
  if (
    rootCanonical !== state.root ||
    !sameEntryIdentity(state.rootIdentity, rootIdentity)
  )
    throw new CSharpFailure('path_invalid', relativePath);

  const segments = isRoot ? [] : relativePath.split('/');
  let current = state.root;
  let identity: DiscoveryStats | undefined;
  const ancestors: Array<{
    readonly canonicalPath: string;
    readonly identity: DiscoveryStats;
  }> = [];
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = path.join(current, segments[index - 1]!);
    const stats = await state.filesystem.lstat(current);
    const isFinal = index === segments.length;
    if (stats.isSymbolicLink())
      throw new CSharpFailure('path_invalid', relativePath);
    if (!isFinal && !stats.isDirectory())
      throw new CSharpFailure('path_invalid', relativePath);
    if (
      isFinal &&
      ((kind === 'file' && !stats.isFile()) ||
        (kind === 'directory' && !stats.isDirectory()))
    )
      throw new CSharpFailure('path_invalid', relativePath);
    const canonical = await state.filesystem.realpath(current);
    if (
      pathIdentityKey(canonical) !== pathIdentityKey(current) ||
      (canonical !== state.root && !isContainedPath(state.root, canonical))
    )
      throw new CSharpFailure('path_invalid', relativePath);
    identity = stats;
    const ancestorPath = canonicalRelativePath(state.root, canonical);
    if (ancestorPath === undefined)
      throw new CSharpFailure('path_invalid', relativePath);
    ancestors.push({ canonicalPath: ancestorPath, identity: stats });
  }
  const canonical = await state.filesystem.realpath(absolute);
  const canonicalPath = canonicalRelativePath(state.root, canonical);
  if (canonicalPath === undefined || identity === undefined)
    throw new CSharpFailure('path_invalid', relativePath);
  return { absolute, canonicalPath, identity, ancestors };
}

function sameAncestors(
  left: readonly {
    readonly canonicalPath: string;
    readonly identity: DiscoveryStats;
  }[],
  right: readonly {
    readonly canonicalPath: string;
    readonly identity: DiscoveryStats;
  }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ancestor, index) =>
        pathIdentityKey(ancestor.canonicalPath) ===
          pathIdentityKey(right[index]!.canonicalPath) &&
        sameEntryIdentity(ancestor.identity, right[index]!.identity),
    )
  );
}

function reserveRead(
  state: DiscoveryState,
  size: number,
  maxBytes: number,
  relativePath: string,
): void {
  if (size > maxBytes) throw new CSharpFailure('resource_limit', relativePath);
  if (
    state.readOperations >= CSHARP_MAX_READ_OPERATIONS ||
    state.aggregateReadBytes > CSHARP_MAX_AGGREGATE_READ_BYTES - size
  )
    throw new CSharpFailure('resource_limit', relativePath);
  state.readOperations += 1;
  state.aggregateReadBytes += size;
}

interface InspectedContainedFile {
  readonly absolute: string;
  readonly canonicalPath: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };
  readonly ancestors: readonly {
    readonly canonicalPath: string;
    readonly identity: DiscoveryStats;
  }[];
  readonly bytes?: Buffer;
}

async function inspectContainedFile(
  state: DiscoveryState,
  relativePath: string,
  kind: 'file' | 'directory',
  maxBytes?: number,
  readContent?: boolean,
): Promise<InspectedContainedFile>;
async function inspectContainedFile(
  state: DiscoveryState,
  relativePath: string,
  kind: 'file' | 'directory',
  maxBytes: number | undefined,
  readContent: boolean,
  allowMissing: true,
): Promise<InspectedContainedFile | undefined>;
async function inspectContainedFile(
  state: DiscoveryState,
  relativePath: string,
  kind: 'file' | 'directory',
  maxBytes?: number,
  readContent = true,
  allowMissing = false,
): Promise<InspectedContainedFile | undefined> {
  assertPathBudget(relativePath, relativePath);
  if (
    hasReservedDirectory(relativePath) ||
    isSecretFile(relativePath) ||
    relativePath.includes('\\')
  )
    throw new CSharpFailure('path_invalid', relativePath);
  try {
    const before = await validateContainedPath(state, relativePath, kind);
    if (kind === 'directory') return before;
    const readLimit = maxBytes ?? CSHARP_MAX_SOURCE_BYTES;
    if (!readContent) return before;
    reserveRead(state, before.identity.size, readLimit, relativePath);
    const bytes = await state.filesystem.readFile(
      before.absolute,
      readLimit,
      before.identity,
    );
    if (bytes.byteLength > readLimit)
      throw new CSharpFailure('resource_limit', relativePath);
    const after = await validateContainedPath(state, relativePath, kind);
    if (
      !sameIdentity(before.identity, after.identity) ||
      !sameAncestors(before.ancestors, after.ancestors) ||
      pathIdentityKey(before.canonicalPath) !==
        pathIdentityKey(after.canonicalPath)
    )
      throw new CSharpFailure('path_invalid', relativePath);
    return { ...after, bytes };
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined;
    if (error instanceof CSharpFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EFBIG')
      throw new CSharpFailure('resource_limit', relativePath);
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN')
      throw new CSharpFailure('path_invalid', relativePath);
    throw new CSharpFailure('io_error', relativePath);
  }
}

async function readXml(
  state: DiscoveryState,
  relativePath: string,
): Promise<string> {
  const file = await inspectContainedFile(
    state,
    relativePath,
    'file',
    CSHARP_MAX_XML_BYTES,
  );
  const bytes = file.bytes!;
  if (
    state.aggregateXmlBytes >
    CSHARP_MAX_AGGREGATE_XML_BYTES - bytes.byteLength
  )
    throw new CSharpFailure('resource_limit', relativePath);
  state.aggregateXmlBytes += bytes.byteLength;
  const source = bytes.toString('utf8');
  if (source.includes('\ufffd'))
    throw new CSharpFailure('xml_invalid', relativePath);
  return source;
}

function validateLiteral(value: string, relativePath: string): string {
  if (hasMsBuildExpression(value))
    throw new CSharpFailure('unsupported_construct', relativePath);
  if (['?', '*', '[', ']', '%'].some((character) => value.includes(character)))
    throw new CSharpFailure('unsupported_construct', relativePath);
  if (
    value.length === 0 ||
    value.includes('\0') ||
    isWindowsUnsafePath(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
    throw new CSharpFailure('path_invalid', relativePath);
  const portable = value.replaceAll('\\', '/');
  if (portable.split('/').some((part) => part.length === 0 || part === '.'))
    throw new CSharpFailure('path_invalid', relativePath);
  assertPathBudget(portable, relativePath);
  return portable;
}

function resolveLiteral(
  base: string,
  value: string,
  relativePath: string,
): string {
  const portable = validateLiteral(value, relativePath);
  const normalized = path.posix.normalize(
    base === '' ? portable : `${base}/${portable}`,
  );
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../'))
    throw new CSharpFailure('path_invalid', relativePath);
  return normalized;
}

function resolveProjectLiteral(
  directory: string,
  value: string,
  relativePath: string,
): string {
  return resolveLiteral(directory, value, relativePath);
}

async function discoverProjectFiles(
  state: DiscoveryState,
  projectPath: string,
  directory: string,
  projectDirectoryEntry: InspectedContainedFile,
): Promise<readonly string[]> {
  const before = projectDirectoryEntry.identity;
  const beforeCanonical = await state.filesystem.realpath(
    projectDirectoryEntry.absolute,
  );
  const discovered = await discoverSourceFiles(projectDirectoryEntry.absolute, {
    filesystem: state.filesystem,
    extensions: ['.cs'],
    includeDeclarations: true,
    excludedDirectoryNames: ['bin', 'obj'],
    consumeDirectoryEntries: (count) => {
      if (state.directoryEntries > MAX_DIRECTORY_ENTRIES - count) return false;
      state.directoryEntries += count;
      return true;
    },
  });
  if (discovered.diagnostics.length > 0) {
    if (discovered.diagnostics.some((item) => item.code === 'resource_limit'))
      throw new CSharpFailure('resource_limit', projectPath);
    throw new CSharpFailure('path_invalid', projectPath);
  }
  const after = await state.filesystem.lstat(projectDirectoryEntry.absolute);
  const afterCanonical = await state.filesystem.realpath(
    projectDirectoryEntry.absolute,
  );
  if (!sameEntryIdentity(before, after) || beforeCanonical !== afterCanonical)
    throw new CSharpFailure('path_invalid', projectPath);
  if (discovered.repositoryRoot !== afterCanonical)
    throw new CSharpFailure('path_invalid', projectPath);

  const files = new Map<string, string>();
  for (const localPath of discovered.sources) {
    const candidate = joinRelative(directory, localPath);
    const inspected = await inspectContainedFile(
      state,
      candidate,
      'file',
      CSHARP_MAX_SOURCE_BYTES,
    );
    const canonical = inspected.canonicalPath;
    const directoryKey = pathIdentityKey(projectDirectoryEntry.canonicalPath);
    const candidateKey = pathIdentityKey(canonical);
    if (
      directoryKey !== '.' &&
      candidateKey !== directoryKey &&
      !candidateKey.startsWith(`${directoryKey}/`)
    )
      throw new CSharpFailure('path_invalid', projectPath);
    files.set(candidateKey, canonical);
  }
  return [...files.values()].sort(ordinal);
}

async function parseProject(
  state: DiscoveryState,
  projectPath: string,
): Promise<{
  readonly manifest: CSharpProjectManifest;
  readonly references: readonly string[];
}> {
  if (state.projectCount >= CSHARP_MAX_PROJECTS)
    throw new CSharpFailure('resource_limit', projectPath);
  state.projectCount += 1;
  const source = await readXml(state, projectPath);
  let parsed: ParsedProject;
  try {
    parsed = parseProjectXml(source);
  } catch (error) {
    if (error instanceof CSharpFailure && error.relativePath === undefined)
      throw new CSharpFailure(error.code, projectPath);
    throw error;
  }
  const directory = projectDirectory(projectPath);
  const explicitOperationCount =
    parsed.compile.length + parsed.references.length;
  if (
    parsed.compile.length > CSHARP_MAX_EXPLICIT_COMPILE_ITEMS ||
    parsed.references.length > CSHARP_MAX_PROJECT_REFERENCES ||
    state.explicitOperations >
      CSHARP_MAX_EXPLICIT_OPERATIONS - explicitOperationCount
  )
    throw new CSharpFailure('resource_limit', projectPath);
  state.explicitOperations += explicitOperationCount;
  const absoluteDirectory = await inspectContainedFile(
    state,
    directory || '.',
    'directory',
  );
  const defaultFiles = new Map(
    (
      await discoverProjectFiles(
        state,
        projectPath,
        directory,
        absoluteDirectory,
      )
    ).map((file) => [pathIdentityKey(file), file] as const),
  );
  const compileOperations: Array<{
    readonly kind: 'include' | 'remove';
    readonly path: string;
    readonly identityKey?: string;
    readonly exists?: boolean;
  }> = [];
  const includeTargets = new Map<
    string,
    { readonly file: string; readonly identityKey: string }
  >();
  for (const operation of parsed.compile) {
    const file = resolveProjectLiteral(directory, operation.value, projectPath);
    if (!file.toLowerCase().endsWith('.cs'))
      throw new CSharpFailure('unsupported_construct', projectPath);
    assertPathBudget(file, projectPath);
    if (hasReservedDirectory(file) || isSecretFile(file))
      throw new CSharpFailure('path_invalid', file);
    if (operation.kind === 'remove') {
      const inspected = await inspectContainedFile(
        state,
        file,
        'file',
        undefined,
        false,
        true,
      );
      compileOperations.push({
        kind: operation.kind,
        path: inspected?.canonicalPath ?? file,
        exists: inspected !== undefined,
      });
      continue;
    }
    const inspected = await inspectContainedFile(
      state,
      file,
      'file',
      undefined,
      false,
    );
    const identityKey = `${inspected.identity.dev}:${inspected.identity.ino}`;
    compileOperations.push({
      kind: operation.kind,
      path: inspected.canonicalPath,
      identityKey,
    });
    if (!includeTargets.has(identityKey))
      includeTargets.set(identityKey, { file, identityKey });
  }
  if (includeTargets.size > CSHARP_MAX_EXPLICIT_INCLUDE_READS)
    throw new CSharpFailure('resource_limit', projectPath);
  const includedFiles = new Map<string, string>();
  for (const target of includeTargets.values()) {
    state.explicitIncludeReads += 1;
    if (state.explicitIncludeReads > CSHARP_MAX_EXPLICIT_INCLUDE_READS)
      throw new CSharpFailure('resource_limit', projectPath);
    const inspected = await inspectContainedFile(
      state,
      target.file,
      'file',
      CSHARP_MAX_SOURCE_BYTES,
    );
    if (
      hasReservedDirectory(inspected.canonicalPath) ||
      isSecretFile(inspected.canonicalPath)
    )
      throw new CSharpFailure('path_invalid', inspected.canonicalPath);
    const actualIdentityKey = `${inspected.identity.dev}:${inspected.identity.ino}`;
    if (actualIdentityKey !== target.identityKey)
      throw new CSharpFailure('path_invalid', target.file);
    includedFiles.set(target.identityKey, inspected.canonicalPath);
  }
  for (const operation of compileOperations) {
    if (operation.kind === 'include') {
      const file =
        operation.identityKey === undefined
          ? undefined
          : includedFiles.get(operation.identityKey);
      if (file === undefined)
        throw new CSharpFailure('path_invalid', operation.path);
      defaultFiles.set(pathIdentityKey(operation.path), operation.path);
    } else if (operation.exists) {
      defaultFiles.delete(pathIdentityKey(operation.path));
    }
  }
  const files = [...defaultFiles.values()].sort(ordinal);
  state.fileCount += files.length;
  if (state.fileCount > CSHARP_MAX_PROJECT_FILES)
    throw new CSharpFailure('resource_limit', projectPath);

  const references: string[] = [];
  for (const value of parsed.references) {
    if (references.length >= CSHARP_MAX_PROJECT_REFERENCES)
      throw new CSharpFailure('resource_limit', projectPath);
    const reference = resolveLiteral(directory, value, projectPath);
    if (!isProjectPath(reference))
      throw new CSharpFailure('unsupported_construct', projectPath);
    const inspected = await inspectContainedFile(state, reference, 'file');
    if (!isProjectPath(inspected.canonicalPath))
      throw new CSharpFailure('unsupported_construct', projectPath);
    references.push(inspected.canonicalPath);
  }
  const uniqueReferences = new Map<string, string>();
  for (const reference of references)
    uniqueReferences.set(pathIdentityKey(reference), reference);
  const orderedReferences = [...uniqueReferences.values()].sort(ordinal);
  const project: CSharpProjectManifest = Object.freeze({
    path: projectPath,
    ...(parsed.targetFramework === undefined
      ? {}
      : { targetFramework: parsed.targetFramework }),
    ...(parsed.langVersion === undefined
      ? {}
      : { langVersion: parsed.langVersion }),
    references: freezeArray(orderedReferences),
    files: freezeArray(files),
  });
  return { manifest: project, references: freezeArray(orderedReferences) };
}

async function parseSolution(
  state: DiscoveryState,
  solutionPath: string,
): Promise<readonly string[]> {
  const source = await readXml(state, solutionPath);
  if (solutionPath.toLowerCase().endsWith('.sln')) {
    if (source.includes('\ufffd'))
      throw new CSharpFailure('xml_invalid', solutionPath);
    try {
      return parseSolutionText(source);
    } catch (error) {
      if (error instanceof CSharpFailure && error.relativePath === undefined)
        throw new CSharpFailure(error.code, solutionPath);
      throw error;
    }
  }
  try {
    return parseSolutionXml(source);
  } catch (error) {
    if (error instanceof CSharpFailure && error.relativePath === undefined)
      throw new CSharpFailure(error.code, solutionPath);
    throw error;
  }
}

export async function discoverCSharpManifest(
  repositoryRoot: string,
  selection: CSharpDiscoverySelection,
  options: DiscoverCSharpManifestOptions = {},
): Promise<CSharpManifestResult> {
  if (isRemoteRoot(repositoryRoot)) return failureResult('path_invalid');
  const solution = selection.solution;
  const project = selection.project;
  if ((solution === undefined) === (project === undefined))
    return failureResult('invalid_selection');
  const selected = solution ?? project!;
  const normalized = normalizeRelativePath(selected);
  if (normalized === undefined) return failureResult('path_invalid');
  if (isPathOverBudget(normalized))
    return failureResult('resource_limit', normalized);
  const kind: CSharpSelectionKind =
    solution === undefined ? 'project' : 'solution';
  if (
    kind === 'project'
      ? !isProjectPath(normalized)
      : !isSolutionPath(normalized)
  )
    return failureResult('invalid_selection', normalized);
  try {
    const filesystem = options.filesystem ?? createDefaultDiscoveryFileSystem();
    const root = await filesystem.realpath(repositoryRoot);
    const rootStats = await filesystem.stat(root);
    if (!rootStats.isDirectory()) return failureResult('path_invalid');
    const rootIdentity = await filesystem.lstat(root);
    if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory())
      return failureResult('path_invalid');
    const state: DiscoveryState = {
      root,
      rootIdentity,
      filesystem,
      aggregateXmlBytes: 0,
      aggregateReadBytes: 0,
      readOperations: 0,
      projectCount: 0,
      fileCount: 0,
      explicitIncludeReads: 0,
      explicitOperations: 0,
      directoryEntries: 0,
    };
    const selectedEntry = await inspectContainedFile(state, normalized, 'file');
    const canonicalSelection = selectedEntry.canonicalPath;
    let solutionProjects: readonly string[] | undefined;
    if (kind === 'solution') {
      solutionProjects = await parseSolution(state, normalized);
      if (solutionProjects.length > CSHARP_MAX_SOLUTION_PROJECTS)
        throw new CSharpFailure('resource_limit', normalized);
    }
    let allowedSolutionProjects: ReadonlySet<string> | undefined;
    let pending: string[];
    if (kind === 'solution') {
      const canonicalProjects = new Map<string, string>();
      for (const item of solutionProjects ?? []) {
        const requested = resolveLiteral(
          projectDirectory(canonicalSelection),
          item,
          canonicalSelection,
        );
        if (!isProjectPath(requested))
          throw new CSharpFailure('unsupported_construct', requested);
        const entry = await inspectContainedFile(state, requested, 'file');
        canonicalProjects.set(
          pathIdentityKey(entry.canonicalPath),
          entry.canonicalPath,
        );
      }
      allowedSolutionProjects = new Set(canonicalProjects.keys());
      pending = [...canonicalProjects.values()];
    } else {
      pending = [canonicalSelection];
    }
    const projects = new Map<string, CSharpProjectManifest>();
    for (let index = 0; index < pending.length; index += 1) {
      const requestedProject = pending[index]!;
      if (!isProjectPath(requestedProject))
        throw new CSharpFailure('unsupported_construct', requestedProject);
      const projectEntry = await inspectContainedFile(
        state,
        requestedProject,
        'file',
      );
      const projectPath = projectEntry.canonicalPath;
      const projectKey = pathIdentityKey(projectPath);
      if (projects.has(projectKey)) continue;
      const parsed = await parseProject(state, projectPath);
      projects.set(projectKey, parsed.manifest);
      for (const reference of parsed.references) {
        if (
          (kind === 'project' ||
            allowedSolutionProjects?.has(pathIdentityKey(reference))) &&
          !projects.has(pathIdentityKey(reference)) &&
          !pending.some(
            (candidate) =>
              pathIdentityKey(candidate) === pathIdentityKey(reference),
          )
        )
          pending.push(reference);
      }
    }
    if (projects.size > CSHARP_MAX_PROJECTS)
      throw new CSharpFailure('resource_limit', normalized);
    const orderedProjects = [...projects.values()].sort((left, right) =>
      ordinal(left.path, right.path),
    );
    const manifest: CSharpManifest = Object.freeze({
      language: 'csharp',
      selection: Object.freeze({ kind, path: canonicalSelection }),
      ...(kind === 'solution'
        ? {
            solution: Object.freeze({
              path: canonicalSelection,
              projects: freezeArray(orderedProjects.map((item) => item.path)),
            } satisfies CSharpSolutionManifest),
          }
        : {}),
      projects: freezeArray(orderedProjects),
    });
    return Object.freeze({ manifest, diagnostics: freezeArray([]) });
  } catch (error) {
    if (error instanceof CSharpFailure)
      return failureResult(error.code, error.relativePath);
    return failureResult('io_error', normalized);
  }
}

export const discoverCSharpProjectManifest = discoverCSharpManifest;
