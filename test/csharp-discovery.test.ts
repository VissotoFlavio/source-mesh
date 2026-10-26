import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { discoverCSharpManifest } from '../src/index.js';
import { main, type CliIO, type CliServices } from '../src/cli.js';
import {
  CSHARP_MAX_XML_ATTRIBUTES_PER_NODE,
  CSHARP_MAX_XML_DEPTH,
  CSHARP_MAX_XML_NODES,
  CSHARP_MAX_XML_TEXT_ATTRIBUTE_BYTES,
} from '../src/csharp/contracts.js';
import {
  MAX_DIRECTORY_ENTRIES,
  readFileBounded,
  type DiscoveryDirectory,
  type DiscoveryDirent,
  type DiscoveryFileSystem,
} from '../src/discovery.js';

const roots: string[] = [];

function directoryHandle(
  entries: readonly DiscoveryDirent[],
): DiscoveryDirectory {
  let index = 0;
  return {
    next: async () => entries[index++],
    close: async () => {},
  };
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemesh-csharp-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string | Buffer): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function capture(): CliIO & {
  readonly stdoutValue: string;
  readonly stderrValue: string;
} {
  let stdoutValue = '';
  let stderrValue = '';
  return {
    stdout: (value) => {
      stdoutValue += value;
    },
    stderr: (value) => {
      stderrValue += value;
    },
    get stderrValue() {
      return stderrValue;
    },
    get stdoutValue() {
      return stdoutValue;
    },
  };
}

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

test('csharp project discovery builds a contained reference closure and compile manifest', async () => {
  const root = fixture();
  write(
    root,
    'src/App/App.csproj',
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework><LangVersion>latest</LangVersion></PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Lib\\Lib.csproj" />
    <Compile Remove="Ignored.cs" />
    <Compile Include="Extra.cs" />
  </ItemGroup>
</Project>`,
  );
  write(root, 'src/App/Main.cs', 'class Main {}');
  write(root, 'src/App/Ignored.cs', 'class Ignored {}');
  write(root, 'src/App/Extra.cs', 'class Extra {}');
  write(
    root,
    'src/Lib/Lib.csproj',
    '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
  );
  write(root, 'src/Lib/Lib.cs', 'class Lib {}');

  const result = await discoverCSharpManifest(root, {
    project: 'src/App/App.csproj',
  });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.manifest);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.deepEqual(
    result.manifest.projects.map((item) => item.path),
    ['src/App/App.csproj', 'src/Lib/Lib.csproj'],
  );
  assert.deepEqual(result.manifest.projects[0]!.files, [
    'src/App/Extra.cs',
    'src/App/Main.cs',
  ]);
  assert.deepEqual(result.manifest.projects[0]!.references, [
    'src/Lib/Lib.csproj',
  ]);
  assert.equal(result.manifest.projects[0]!.targetFramework, 'net8.0');
  assert.equal(result.manifest.projects[0]!.langVersion, 'latest');
  assert.equal(JSON.stringify(result.manifest).includes(root), false);
  assert.equal(JSON.stringify(result.manifest).includes('<Project'), false);
});

test('csharp discovery supports bounded SDK metadata and recursive item removals', async () => {
  const root = fixture();
  write(
    root,
    'App.csproj',
    `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <UserSecretsId>synthetic-development</UserSecretsId>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Remove="Generated\\**" />
    <Content Remove="Generated\\**" />
    <EmbeddedResource Remove="Generated\\**" />
    <None Remove="Generated\\**" />
    <EmbeddedResource Include="data\\resource.json" Link="Resources\\resource.json" LogicalName="Synthetic.Resource" />
    <PackageReference Include="Synthetic.Package" Version="1.0.0" PrivateAssets="all" />
  </ItemGroup>
</Project>`,
  );
  write(root, 'App.cs', 'class App {}');
  write(root, 'Generated/Excluded.cs', 'class Excluded {}');
  write(root, 'Generated/Nested/AlsoExcluded.cs', 'class AlsoExcluded {}');
  write(root, 'data/resource.json', '{}');

  const result = await discoverCSharpManifest(root, { project: 'App.csproj' });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.manifest?.projects[0]?.files, ['App.cs']);
  assert.equal(
    JSON.stringify(result.manifest).includes('Synthetic.Package'),
    false,
  );
  assert.equal(
    JSON.stringify(result.manifest).includes('resource.json'),
    false,
  );
});

test('csharp discovery rejects unsupported SDK item variants', async () => {
  const root = fixture();
  write(root, 'App.cs', 'class App {}');
  const cases = [
    {
      content:
        '<Project><ItemGroup><Compile Remove="Generated\\*\\*.cs" /></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
    {
      content:
        '<Project><ItemGroup><Compile Remove="..\\outside\\**" /></ItemGroup></Project>',
      code: 'path_invalid',
    },
    {
      content:
        '<Project><ItemGroup><Content Include="data\\resource.json" /></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
    {
      content:
        '<Project><ItemGroup><PackageReference Include="Synthetic.Package"><Unsupported>all</Unsupported></PackageReference></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
    {
      content:
        '<Project><ItemGroup><Compile Include="App.cs" Link="..\\outside\\App.cs" /></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
    {
      content:
        '<Project><ItemGroup><Compile Include="App.cs" Link="Linked\\*.cs" /></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
    {
      content:
        '<Project><ItemGroup><EmbeddedResource Include="data\\resource.json" Link="Resources\\resource.json" LogicalName="Synthetic/Resource" /></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
    {
      content:
        '<Project><ItemGroup><EmbeddedResource Include="data\\resource.json" LogicalName="$(LogicalName)" /></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
    {
      content:
        '<Project><ItemGroup><EmbeddedResource Include="data\\resource.json" LogicalName=".." /></ItemGroup></Project>',
      code: 'unsupported_construct',
    },
  ];

  for (const item of cases) {
    write(root, 'App.csproj', item.content);
    const result = await discoverCSharpManifest(root, {
      project: 'App.csproj',
    });
    assert.equal(result.manifest, undefined);
    assert.equal(result.diagnostics[0]?.code, item.code);
  }
});

test('csharp project discovery excludes generated sources under bin and obj', async () => {
  const root = fixture();
  write(root, 'App.csproj', '<Project />');
  write(root, 'App.cs', 'class App {}');
  write(root, 'bin/Debug/net8.0/App.AssemblyInfo.cs', 'class GeneratedBin {}');
  write(root, 'obj/Debug/net8.0/App.AssemblyInfo.cs', 'class GeneratedObj {}');

  const result = await discoverCSharpManifest(root, {
    project: 'App.csproj',
  });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.manifest?.projects[0]?.files, ['App.cs']);
});

test('csharp XML structural limits fail closed without a manifest', async () => {
  const cases = [
    `<Project>${'<ItemGroup />'.repeat(CSHARP_MAX_XML_NODES)}</Project>`,
    `${'<Project>'.repeat(CSHARP_MAX_XML_DEPTH + 1)}${'</Project>'.repeat(CSHARP_MAX_XML_DEPTH + 1)}`,
    `<Project ${Array.from(
      { length: CSHARP_MAX_XML_ATTRIBUTES_PER_NODE + 1 },
      (_, index) => `a${index}="x"`,
    ).join(' ')} />`,
    `<Project>${'x'.repeat(CSHARP_MAX_XML_TEXT_ATTRIBUTE_BYTES + 1)}</Project>`,
  ];

  for (const [index, xml] of cases.entries()) {
    const root = fixture();
    write(root, `App${index}.csproj`, xml);
    const result = await discoverCSharpManifest(root, {
      project: `App${index}.csproj`,
    });
    assert.equal(result.manifest, undefined);
    assert.equal(result.diagnostics[0]?.code, 'resource_limit');
  }
});

test('csharp Compile operations preserve XML order and allow contained external files', async () => {
  const root = fixture();
  write(
    root,
    'src/App/App.csproj',
    `<Project><ItemGroup>
      <Compile Remove="../Missing.cs" />
      <Compile Include="../Shared.cs" />
      <Compile Include="../Other.cs" />
      <Compile Remove="../Other.cs" />
    </ItemGroup></Project>`,
  );
  write(root, 'src/App/App.cs', 'class App {}');
  write(root, 'src/Shared.cs', 'class Shared {}');
  write(root, 'src/Other.cs', 'class Other {}');

  const result = await discoverCSharpManifest(root, {
    project: 'src/App/App.csproj',
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.manifest?.projects[0]?.files, [
    'src/App/App.cs',
    'src/Shared.cs',
  ]);
});

test('csharp Compile Include preserves distinct paths sharing one identity', async () => {
  const root = fixture();
  write(
    root,
    'src/App/App.csproj',
    `<Project><ItemGroup>
      <Compile Remove="App.cs" />
      <Compile Remove="A.cs" />
      <Compile Remove="B.cs" />
      <Compile Include="A.cs" />
      <Compile Include="B.cs" />
    </ItemGroup></Project>`,
  );
  write(root, 'src/App/App.cs', 'class App {}');
  write(root, 'src/App/A.cs', 'class Shared {}');
  write(root, 'src/App/B.cs', 'class Shared {}');
  const aliases = new Set([
    path.join(root, 'src', 'App', 'A.cs'),
    path.join(root, 'src', 'App', 'B.cs'),
  ]);
  const readCalls: string[] = [];
  const filesystem: DiscoveryFileSystem = {
    realpath: (candidate) => fs.promises.realpath(candidate),
    stat: (candidate) => fs.promises.stat(candidate),
    lstat: async (candidate) => {
      const stats = await fs.promises.lstat(candidate);
      if (!aliases.has(candidate)) return stats;
      return {
        dev: 1,
        ino: 777,
        size: stats.size,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    openDirectory: async (directory) =>
      directoryHandle(
        await fs.promises.readdir(directory, { withFileTypes: true }),
      ),
    readFile: async (candidate, maxBytes) => {
      readCalls.push(candidate);
      return readFileBounded(candidate, maxBytes);
    },
  };

  const result = await discoverCSharpManifest(
    root,
    { project: 'src/App/App.csproj' },
    { filesystem },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.manifest?.projects[0]?.files, [
    'src/App/A.cs',
    'src/App/B.cs',
  ]);
  assert.equal(
    readCalls.filter((candidate) => candidate.endsWith('A.cs')).length,
    2,
  );
  assert.equal(
    readCalls.filter((candidate) => candidate.endsWith('B.cs')).length,
    1,
  );
});

test('csharp Compile Remove validates existing links instead of treating them as missing', async () => {
  const root = fixture();
  write(
    root,
    'src/App/App.csproj',
    '<Project><ItemGroup><Compile Remove="../../Shared.cs" /></ItemGroup></Project>',
  );
  write(root, 'src/App/App.cs', 'class App {}');
  write(root, 'Shared.cs', 'class Shared {}');
  const linkedPath = path.join(root, 'Shared.cs');
  const filesystem: DiscoveryFileSystem = {
    realpath: (candidate) => fs.promises.realpath(candidate),
    stat: (candidate) => fs.promises.stat(candidate),
    lstat: async (candidate) => {
      if (candidate === linkedPath)
        return {
          dev: 1,
          ino: 2,
          size: 0,
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      return fs.promises.lstat(candidate);
    },
    openDirectory: async (directory) =>
      directoryHandle(
        await fs.promises.readdir(directory, { withFileTypes: true }),
      ),
    readFile: (candidate, maxBytes) => readFileBounded(candidate, maxBytes),
  };

  const result = await discoverCSharpManifest(
    root,
    { project: 'src/App/App.csproj' },
    { filesystem },
  );
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'path_invalid');
});

test('csharp solution discovery resolves contained project paths deterministically', async () => {
  const root = fixture();
  write(
    root,
    'solutions/App.sln',
    'Microsoft Visual Studio Solution File, Format Version 12.00\nProject("{A}") = "App", "..\\src\\App\\App.csproj", "{B}"\nEndProject\n',
  );
  write(
    root,
    'src/App/App.csproj',
    '<Project><ItemGroup><ProjectReference Include="../Unlisted/Unlisted.csproj" /></ItemGroup></Project>',
  );
  write(root, 'src/App/App.cs', 'class App {}');
  write(root, 'src/Unlisted/Unlisted.csproj', '<Project />');

  const result = await discoverCSharpManifest(root, {
    solution: 'solutions/App.sln',
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.manifest?.solution, {
    path: 'solutions/App.sln',
    projects: ['src/App/App.csproj'],
  });
  assert.deepEqual(
    result.manifest?.projects.map((item) => item.path),
    ['src/App/App.csproj'],
  );
  assert.deepEqual(result.manifest?.projects[0]?.references, [
    'src/Unlisted/Unlisted.csproj',
  ]);
});

test('csharp discovery rejects conditions, external paths, and XML entities', async () => {
  const root = fixture();
  write(root, 'App.cs', 'class App {}');
  write(
    root,
    'App.csproj',
    '<Project><PropertyGroup Condition="true"><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
  );
  let result = await discoverCSharpManifest(root, { project: 'App.csproj' });
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'unsupported_construct');

  write(root, 'App.csproj', '<!DOCTYPE Project [<!ENTITY x "y">]><Project />');
  result = await discoverCSharpManifest(root, { project: 'App.csproj' });
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'unsupported_construct');

  write(
    root,
    'App.csproj',
    '<Project><ItemGroup><ProjectReference Include="..\\outside\\Other.csproj" /></ItemGroup></Project>',
  );
  result = await discoverCSharpManifest(root, { project: 'App.csproj' });
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'path_invalid');

  for (const content of [
    '<Project Sdk="bad<value" />',
    '<Project><PropertyGroup><TargetFramework>bad<value</TargetFramework></PropertyGroup></Project>',
    '<?xml version="1.0"?><Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project><?not-allowed?>',
    '<?xml version="1.0" encoding="utf-8" standalone="maybe"?><Project />',
    '<Project>bad\u0001</Project>',
    '<Project><!--bad--comment--></Project>',
    '<Project><!--bad---></Project>',
    '<Project>bad]]></Project>',
    '<Project\u00a0/>',
    '<Project Sdk="$(Sdk)" />',
    '<Project><PropertyGroup><TargetFramework>$(TargetFramework)</TargetFramework></PropertyGroup></Project>',
    '<Project><ItemGroup><ProjectReference Include="@(Reference)" /></ItemGroup></Project>',
    '<Project><ItemGroup><Compile Remove="%(Compile)" /></ItemGroup></Project>',
  ]) {
    write(root, 'App.csproj', content);
    result = await discoverCSharpManifest(root, { project: 'App.csproj' });
    assert.equal(result.manifest, undefined);
    assert.ok(
      result.diagnostics[0]?.code === 'xml_invalid' ||
        result.diagnostics[0]?.code === 'unsupported_construct',
    );
  }
});

test('csharp discovery applies bounded path budgets to selectors and literals', async () => {
  const root = fixture();
  const tooDeep = `${'nested/'.repeat(257)}App.csproj`;
  let result = await discoverCSharpManifest(root, { project: tooDeep });
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'resource_limit');

  write(
    root,
    'App.csproj',
    `<Project><ItemGroup><Compile Include="${'nested/'.repeat(257)}App.cs" /></ItemGroup></Project>`,
  );
  write(root, 'App.cs', 'class App {}');
  result = await discoverCSharpManifest(root, { project: 'App.csproj' });
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'resource_limit');
});

test(
  'csharp Windows selectors and literals reject ADS and reserved devices',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fixture();
    write(root, 'App.cs', 'class App {}');
    write(root, 'App.csproj', '<Project />');

    let result = await discoverCSharpManifest(root, {
      project: 'CON.csproj',
    });
    assert.equal(result.manifest, undefined);
    assert.equal(result.diagnostics[0]?.code, 'path_invalid');

    write(
      root,
      'App.csproj',
      '<Project><ItemGroup><Compile Include="source:stream.cs" /></ItemGroup></Project>',
    );
    result = await discoverCSharpManifest(root, { project: 'App.csproj' });
    assert.equal(result.manifest, undefined);
    assert.equal(result.diagnostics[0]?.code, 'path_invalid');
  },
);

test('csharp discovery preserves resource limits and discards the manifest', async () => {
  const root = fixture();
  write(root, 'App.csproj', '<Project />');
  write(root, 'App.cs', Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  const result = await discoverCSharpManifest(root, { project: 'App.csproj' });
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'resource_limit');
});

test('csharp discovery aggregates directory metadata entries across projects', async () => {
  const root = fixture();
  write(
    root,
    'solutions/App.sln',
    'Project("{A}") = "A", "..\\src\\A\\A.csproj", "{B}"\nEndProject\n' +
      'Project("{A}") = "B", "..\\src\\B\\B.csproj", "{C}"\nEndProject\n',
  );
  write(root, 'src/A/A.csproj', '<Project />');
  write(root, 'src/B/B.csproj', '<Project />');
  const largeDirectorySize = Math.floor(MAX_DIRECTORY_ENTRIES / 2) + 1;
  const metadataStats = {
    dev: 1,
    ino: 1,
    size: 0,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const filesystem: DiscoveryFileSystem = {
    realpath: (candidate) => fs.promises.realpath(candidate),
    stat: (candidate) => fs.promises.stat(candidate),
    lstat: (candidate) => {
      if (
        (candidate.startsWith(`${path.join(root, 'src', 'A')}${path.sep}`) ||
          candidate.startsWith(`${path.join(root, 'src', 'B')}${path.sep}`)) &&
        path.basename(candidate).startsWith('metadata-')
      )
        return Promise.resolve(metadataStats);
      return fs.promises.lstat(candidate);
    },
    openDirectory: async (directory) => {
      if (
        directory === path.join(root, 'src', 'A') ||
        directory === path.join(root, 'src', 'B')
      ) {
        let index = 0;
        return {
          next: async () => {
            if (index >= largeDirectorySize) return undefined;
            const entry = {
              name: `metadata-${index}.txt`,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            };
            index += 1;
            return entry;
          },
          close: async () => {},
        };
      }
      return directoryHandle(
        await fs.promises.readdir(directory, { withFileTypes: true }),
      );
    },
    readFile: (candidate, maxBytes) => readFileBounded(candidate, maxBytes),
  };

  const result = await discoverCSharpManifest(
    root,
    { solution: 'solutions/App.sln' },
    { filesystem },
  );
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'resource_limit');
});

test('csharp discovery fails closed when the repository root changes during validation', async () => {
  const root = fixture();
  write(root, 'App.csproj', '<Project />');
  write(root, 'App.cs', 'class App {}');
  let rootLstatCalls = 0;
  const filesystem: DiscoveryFileSystem = {
    realpath: (candidate) => fs.promises.realpath(candidate),
    stat: (candidate) => fs.promises.stat(candidate),
    lstat: async (candidate) => {
      if (candidate === root && rootLstatCalls++ > 0)
        return {
          dev: 99_999,
          ino: 99_999,
          size: 0,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      return fs.promises.lstat(candidate);
    },
    openDirectory: async (directory) =>
      directoryHandle(
        await fs.promises.readdir(directory, { withFileTypes: true }),
      ),
    readFile: (candidate, maxBytes) => readFileBounded(candidate, maxBytes),
  };
  const result = await discoverCSharpManifest(
    root,
    { project: 'App.csproj' },
    { filesystem },
  );
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'path_invalid');
});

test('csharp discovery deduplicates includes before bounded reads and caps repetition', async () => {
  const root = fixture();
  write(root, 'App.cs', 'class App {}');
  const duplicateIncludes = Array.from(
    { length: 4 },
    () => '<Compile Include="App.cs" />',
  ).join('');
  write(
    root,
    'App.csproj',
    `<Project><ItemGroup>${duplicateIncludes}</ItemGroup></Project>`,
  );
  let readFileCalls = 0;
  const filesystem: DiscoveryFileSystem = {
    realpath: (candidate) => fs.promises.realpath(candidate),
    stat: (candidate) => fs.promises.stat(candidate),
    lstat: (candidate) => fs.promises.lstat(candidate),
    openDirectory: async (directory) =>
      directoryHandle(
        await fs.promises.readdir(directory, { withFileTypes: true }),
      ),
    readFile: async (candidate, maxBytes) => {
      readFileCalls += 1;
      return readFileBounded(candidate, maxBytes);
    },
  };
  let result = await discoverCSharpManifest(
    root,
    { project: 'App.csproj' },
    { filesystem },
  );
  assert.deepEqual(result.manifest?.projects[0]?.files, ['App.cs']);
  assert.equal(readFileCalls, 5);

  const repeated = Array.from(
    { length: 4097 },
    () => '<Compile Include="App.cs" />',
  ).join('');
  write(
    root,
    'App.csproj',
    `<Project><ItemGroup>${repeated}</ItemGroup></Project>`,
  );
  readFileCalls = 0;
  result = await discoverCSharpManifest(
    root,
    { project: 'App.csproj' },
    { filesystem },
  );
  assert.equal(result.manifest, undefined);
  assert.equal(result.diagnostics[0]?.code, 'resource_limit');
  assert.equal(readFileCalls, 3);
});

test('csharp CLI keeps the discovery-only service seam explicit', async () => {
  const root = fixture();
  write(
    root,
    'App.csproj',
    '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
  );
  write(root, 'App.cs', 'class App {}');
  const discoveryOnlyServices = {
    discoverCSharpManifest,
  } as unknown as CliServices;
  const jsonIO = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        root,
        '--language',
        'csharp',
        '--project',
        'App.csproj',
        '--output',
        'json',
      ],
      discoveryOnlyServices,
      jsonIO,
    ),
    0,
  );
  const response = JSON.parse(jsonIO.stdoutValue) as {
    readonly result: { readonly kind: string; readonly manifest: unknown };
  };
  assert.equal(response.result.kind, 'csharp-manifest');
  assert.ok(response.result.manifest);
  assert.equal(jsonIO.stdoutValue.includes(root), false);
  assert.equal(
    fs.existsSync(path.join(root, '.sourcemesh', 'graph.json')),
    false,
  );

  const humanIO = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        root,
        '--language',
        'csharp',
        '--project',
        'App.csproj',
      ],
      discoveryOnlyServices,
      humanIO,
    ),
    0,
  );
  assert.match(humanIO.stdoutValue, /C# manifest discovery completed/u);
  assert.equal(humanIO.stderrValue, '');

  const failureIO = capture();
  assert.equal(
    await main(
      [
        'analyze',
        '--root',
        root,
        '--language',
        'csharp',
        '--project',
        'Missing.csproj',
        '--output',
        'json',
      ],
      undefined,
      failureIO,
    ),
    1,
  );
  assert.equal(failureIO.stdoutValue, '');
  assert.deepEqual(
    JSON.parse(failureIO.stderrValue).error.code,
    'analysis_failed',
  );
});

test(
  'csharp project paths are canonicalized and aliases are deduplicated on Windows',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fixture();
    write(
      root,
      'src/App/App.csproj',
      '<Project><ItemGroup><ProjectReference Include="app.csproj" /></ItemGroup></Project>',
    );
    write(root, 'src/App/App.cs', 'class App {}');
    const result = await discoverCSharpManifest(root, {
      project: 'SRC\\APP\\APP.CSPROJ',
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.manifest?.projects.map((item) => item.path),
      ['src/App/App.csproj'],
    );
    assert.deepEqual(result.manifest?.projects[0]?.references, [
      'src/App/App.csproj',
    ]);
  },
);

test('csharp CLI selection is explicit and unambiguous', async () => {
  for (const args of [
    ['analyze', '--root', '/repo', '--solution', 'App.sln'],
    ['analyze', '--root', '/repo', '--language', 'csharp'],
    [
      'analyze',
      '--root',
      '/repo',
      '--language',
      'csharp',
      '--solution',
      'App.sln',
      '--project',
      'App.csproj',
    ],
  ]) {
    const io = capture();
    assert.equal(await main(args, undefined, io), 2);
    assert.match(io.stderrValue, /arguments are invalid/u);
  }
});
