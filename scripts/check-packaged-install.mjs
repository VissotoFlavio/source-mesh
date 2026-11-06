import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const execFileAsync = promisify(execFile);
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const manifest = JSON.parse(
  await readFile(
    path.join(repository, 'scripts', 'package-manifest.json'),
    'utf8',
  ),
);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli =
  process.env.npm_execpath ??
  path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
const denyNetwork = path.join(repository, 'scripts', 'deny-network.mjs');
const csharpFixture = path.join(
  repository,
  'test',
  'fixtures',
  'csharp-project',
);
const csharpMcpSnapshotGuide = 'docs/csharp-mcp-snapshot-package-guide.md';

function cleanEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    ...overrides,
  };
}

async function command(command, args, options = {}) {
  const npmInvocation = command === npmCommand;
  return execFileAsync(
    npmInvocation ? process.execPath : command,
    npmInvocation ? [npmCli, ...args] : args,
    {
      cwd: repository,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      ...options,
    },
  );
}

async function expectVerifierFailure(helperRoot) {
  await assert.rejects(
    command(process.execPath, [
      path.join(repository, 'scripts', 'check-package.mjs'),
      '--helper-root',
      helperRoot,
    ]),
  );
}

async function verifyFailureModes(root) {
  const sourceHelper = path.join(repository, ...manifest.helperPath.split('/'));
  const cases = await Promise.all(
    ['missing', 'extra', 'malformed'].map(async (name) => {
      const helper = path.join(root, `helper-${name}`);
      await mkdir(helper, { recursive: true });
      await Promise.all(
        manifest.helperFiles.map(async (item) => {
          const destination = path.join(helper, ...item.path.split('/'));
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(
            path.join(sourceHelper, ...item.path.split('/')),
            destination,
          );
        }),
      );
      await copyFile(
        path.join(sourceHelper, manifest.helperIntegrityFile),
        path.join(helper, manifest.helperIntegrityFile),
      );
      return { helper, name };
    }),
  );
  try {
    await rm(path.join(cases[0].helper, manifest.helperFiles[0].path), {
      force: true,
    });
    await writeFile(
      path.join(cases[1].helper, 'unexpected.dll'),
      Buffer.from('unexpected'),
    );
    await writeFile(
      path.join(cases[2].helper, 'sourcemesh-roslyn.deps.json'),
      '{}',
    );
    for (const item of cases) await expectVerifierFailure(item.helper);
  } finally {
    await Promise.all(
      cases.map((item) => rm(item.helper, { recursive: true, force: true })),
    );
  }
}

async function verifyGuardFailure(root) {
  const untrustedHelper = path.join(root, 'untrusted.dll');
  const script = `import { spawn } from 'node:child_process';
spawn(${JSON.stringify('C:\\Program Files\\dotnet\\dotnet.exe')}, [${JSON.stringify(untrustedHelper)}], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });`;
  await assert.rejects(
    command(
      process.execPath,
      ['--import', pathToFileURL(denyNetwork).href, '-e', script],
      {
        env: cleanEnvironment({ SOURCEMESH_ROSLYN_HELPER: untrustedHelper }),
      },
    ),
  );
}

async function runCli(cli, args, cwd) {
  const env = cleanEnvironment();
  const result = await command(
    process.execPath,
    ['--import', pathToFileURL(denyNetwork).href, cli, ...args],
    { cwd, env },
  );
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function responsePage(result) {
  assert.ok(result.structuredContent);
  const page = result.structuredContent.page;
  assert.ok(page && typeof page === 'object');
  assert.ok(Array.isArray(page.items));
  return page;
}

async function verifyMcp(cli, root, cwd, snapshot) {
  let stderr = '';
  const env = cleanEnvironment();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      pathToFileURL(denyNetwork).href,
      cli,
      'mcp',
      '--root',
      root,
      '--snapshot',
      snapshot,
    ],
    cwd,
    env,
    stderr: 'pipe',
    maxBufferSize: 1024 * 1024,
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({
    name: 'SourceMesh package check',
    version: '0.0.0',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        'searchSymbols',
        'getSymbol',
        'listFileDependencies',
        'listFileDependents',
        'listCallers',
        'listCallees',
      ],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
    }
    assert.equal(
      client.getInstructions()?.includes(csharpMcpSnapshotGuide),
      true,
    );
    const search = await client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'Application', limit: 1 },
    });
    assert.equal(search.isError ?? false, false);
    const searchPage = responsePage(search);
    const symbolId = searchPage.items[0]?.id;
    assert.equal(typeof symbolId, 'string');
    const details = await client.callTool({
      name: 'getSymbol',
      arguments: { nodeId: symbolId },
    });
    assert.equal(details.isError ?? false, false);
    assert.ok(details.structuredContent);
    const detailedSymbolId = details.structuredContent.symbol?.id;
    assert.equal(detailedSymbolId, symbolId);
    const callees = await client.callTool({
      name: 'listCallees',
      arguments: {
        function: { name: 'Run', containerId: detailedSymbolId },
      },
    });
    assert.equal(callees.isError ?? false, false);
    assert.ok(callees.structuredContent);
    const firstPage = await client.callTool({
      name: 'searchSymbols',
      arguments: { query: 'FormatValue', limit: 1 },
    });
    assert.equal(firstPage.isError ?? false, false);
    const first = responsePage(firstPage);
    assert.equal(first.truncated, true);
    assert.equal(typeof first.continuation, 'string');
    const secondPage = await client.callTool({
      name: 'searchSymbols',
      arguments: {
        query: 'FormatValue',
        limit: 1,
        cursor: first.continuation,
      },
    });
    assert.equal(secondPage.isError ?? false, false);
    const second = responsePage(secondPage);
    assert.notEqual(second.items[0]?.id, first.items[0]?.id);
  } finally {
    await client.close().catch(() => undefined);
  }
  assert.equal(stderr, '');
}

if (process.platform !== 'win32') {
  throw new Error(
    'The packaged Roslyn helper is supported only on Windows x64.',
  );
}
assert.equal(process.arch, 'x64');
assert.equal(manifest.platform, 'win32-x64');
assert.equal(manifest.dotnetFramework, 'net10.0');

const temporaryRoot = await mkdtemp(path.join(repository, '.package-check-'));
try {
  const dotnetHost = 'C:\\Program Files\\dotnet\\dotnet.exe';
  await stat(dotnetHost).catch(() => {
    throw new Error('The supported .NET 10 host is unavailable.');
  });
  const dotnetVersion = await command(dotnetHost, ['--version']);
  assert.match(dotnetVersion.stdout.trim(), /^10\./u);
  await verifyFailureModes(temporaryRoot);
  await verifyGuardFailure(temporaryRoot);

  const packResult = await command(npmCommand, [
    'pack',
    '--ignore-scripts=false',
    '--pack-destination',
    temporaryRoot,
    '--json',
  ]);
  const packed = JSON.parse(packResult.stdout);
  const tarballName = packed[0]?.filename;
  assert.equal(typeof tarballName, 'string');
  const tarball = path.resolve(temporaryRoot, tarballName);
  const tarballBytes = (await stat(tarball)).size;
  assert.ok(tarballBytes <= manifest.maxTarballBytes);

  const consumer = path.join(temporaryRoot, 'consumer');
  const cache = path.join(temporaryRoot, 'npm-cache');
  await mkdir(consumer, { recursive: true });
  await mkdir(cache, { recursive: true });
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      name: 'source-mesh-package-check',
      version: '1.0.0',
      private: true,
    }) + '\n',
  );
  await command(
    npmCommand,
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--cache',
      cache,
      '--prefix',
      consumer,
      tarball,
    ],
    { env: cleanEnvironment() },
  );

  const installed = path.join(
    consumer,
    'node_modules',
    '@vissotoflavio',
    'source-mesh',
  );
  const installedGuide = await readFile(
    path.join(installed, ...csharpMcpSnapshotGuide.split('/')),
    'utf8',
  );
  assert.match(
    installedGuide,
    /Generate the snapshot before configuring or starting\s+MCP\./u,
  );
  assert.equal(/[A-Za-z]:[\\/]/u.test(installedGuide), false);
  const installedReadme = await readFile(
    path.join(installed, 'README.md'),
    'utf8',
  );
  assert.match(
    installedReadme,
    /https:\/\/github\.com\/VissotoFlavio\/source-mesh\/blob\/develop\/skills\/sourcemesh\/SKILL\.md/u,
  );
  await command(process.execPath, [
    path.join(repository, 'scripts', 'check-package.mjs'),
    '--root',
    installed,
    '--installed',
  ]);
  const helperProbe = path.join(
    installed,
    ...manifest.helperPath.split('/'),
    'sourcemesh-roslyn.dll',
  );
  const helperBytes = await readFile(helperProbe);
  try {
    await writeFile(
      helperProbe,
      Buffer.concat([helperBytes, Buffer.from([0])]),
    );
    await assert.rejects(
      command(process.execPath, [
        path.join(repository, 'scripts', 'check-package.mjs'),
        '--root',
        installed,
        '--installed',
      ]),
    );
  } finally {
    await writeFile(helperProbe, helperBytes);
  }
  const dependencyProbe = path.join(
    installed,
    'node_modules',
    'zod',
    'index.js',
  );
  const dependencyBytes = await readFile(dependencyProbe);
  try {
    await writeFile(
      dependencyProbe,
      Buffer.concat([dependencyBytes, Buffer.from('\n// tampered')]),
    );
    await assert.rejects(
      command(process.execPath, [
        path.join(repository, 'scripts', 'check-package.mjs'),
        '--root',
        installed,
        '--installed',
      ]),
    );
  } finally {
    await writeFile(dependencyProbe, dependencyBytes);
  }
  const fixture = path.join(temporaryRoot, 'fixture');
  await cp(csharpFixture, fixture, { recursive: true });
  const cli = path.join(installed, 'dist', 'cli.js');
  const initialSnapshotId = 'package-initial';
  const initialSnapshotPath = `.sourcemesh/snapshots/${initialSnapshotId}.json`;
  const analyzeArgs = (snapshotId) => [
    'analyze',
    '--root',
    fixture,
    '--snapshot-id',
    snapshotId,
    '--language',
    'csharp',
    '--solution',
    'Synthetic.sln',
    '--output',
    'json',
  ];
  const analysis = await runCli(cli, analyzeArgs(initialSnapshotId), consumer);
  assert.equal(analysis.schemaVersion, 3);
  assert.equal(analysis.result?.snapshotPath, initialSnapshotPath);
  const snapshot = path.join(fixture, ...initialSnapshotPath.split('/'));
  const snapshotBytes = await readFile(snapshot);
  await assert.rejects(
    command(
      process.execPath,
      [
        '--import',
        pathToFileURL(denyNetwork).href,
        cli,
        ...analyzeArgs(initialSnapshotId),
      ],
      {
        cwd: consumer,
        env: cleanEnvironment(),
      },
    ),
    (error) => {
      assert.match(error.stderr, /snapshot_conflict/u);
      return true;
    },
  );
  assert.deepEqual(await readFile(snapshot), snapshotBytes);
  const handoverSnapshotId = 'package-handover';
  const handoverSnapshotPath = `.sourcemesh/snapshots/${handoverSnapshotId}.json`;
  const handover = await runCli(cli, analyzeArgs(handoverSnapshotId), consumer);
  assert.equal(handover.schemaVersion, 3);
  assert.equal(handover.result?.snapshotPath, handoverSnapshotPath);
  await verifyMcp(cli, fixture, consumer, initialSnapshotPath);
  await verifyMcp(cli, fixture, consumer, handoverSnapshotPath);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
