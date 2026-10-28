import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCP_MAX_MESSAGE_BYTES } from '../dist/mcp/contracts.js';

const repository = process.cwd();
const fixture = path.join(repository, 'test', 'fixtures', 'e2e-project');
const cliEntry = path.join(repository, 'dist', 'cli.js');
const denyNetwork = path.join(repository, 'scripts', 'deny-network.mjs');
const runsArgument = process.argv.indexOf('--runs');
const requestedRuns =
  runsArgument === -1
    ? Number(process.argv[2] ?? 5)
    : Number(process.argv[runsArgument + 1]);
const runs =
  Number.isSafeInteger(requestedRuns) &&
  requestedRuns > 0 &&
  requestedRuns <= 10
    ? requestedRuns
    : (() => {
        throw new Error('--runs must be an integer from 1 through 10');
      })();

function spawnProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repository,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

async function sourceMesh(root, args) {
  const result = await spawnProcess([
    '--import',
    pathToFileURL(denyNetwork).href,
    cliEntry,
    ...args,
  ]);
  if (result.code !== 0) {
    throw new Error(`SourceMesh failed: ${result.stderr}`);
  }
  return result;
}

async function gitRevision() {
  const result = await spawnProcess([
    '-e',
    "process.stdout.write(require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }))",
  ]);
  if (result.code !== 0) throw new Error('Unable to read git revision.');
  return result.stdout.trim();
}

async function measureMcp(root) {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      pathToFileURL(denyNetwork).href,
      cliEntry,
      'mcp',
      '--root',
      root,
    ],
    cwd: repository,
    stderr: 'pipe',
    maxBufferSize: MCP_MAX_MESSAGE_BYTES,
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({
    name: 'SourceMesh measurement',
    version: '0.0.0',
  });
  await client.connect(transport);
  const started = performance.now();
  const response = await client.callTool({
    name: 'searchSymbols',
    arguments: { query: 'LocalService', limit: 1, allowPartial: true },
  });
  const elapsed = performance.now() - started;
  await client.close();
  if (response.isError || stderr !== '')
    throw new Error('MCP measurement failed.');
  return elapsed;
}

const samples = [];
let fixtureStats;
try {
  for (let index = 0; index < runs; index += 1) {
    const root = await mkdtemp(path.join(repository, '.e2e-measure-'));
    try {
      await cp(fixture, root, { recursive: true });
      const analyzeStarted = performance.now();
      await sourceMesh(root, [
        'analyze',
        '--root',
        root,
        '--tsconfig',
        'tsconfig.json',
        '--overwrite',
        '--output',
        'json',
      ]);
      const analyzeMs = performance.now() - analyzeStarted;

      const queryStarted = performance.now();
      await sourceMesh(root, [
        'symbol',
        '--root',
        root,
        '--query',
        'LocalService',
        '--limit',
        '1',
        '--allow-partial',
        '--output',
        'json',
      ]);
      const cliQueryMs = performance.now() - queryStarted;
      const mcpCallMs = await measureMcp(root);
      const snapshotBytes = await readFile(
        path.join(root, '.sourcemesh', 'graph.json'),
      );
      const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
      fixtureStats = {
        files: snapshot.nodes.filter((node) => node.kind === 'file').length,
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
        snapshotBytes: snapshotBytes.length,
      };
      samples.push({ run: index + 1, analyzeMs, cliQueryMs, mcpCallMs });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        node: process.version,
        os: `${os.platform()} ${os.release()} ${os.arch()}`,
        commit: await gitRevision(),
        runs,
        fixture: fixtureStats,
        samples,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
