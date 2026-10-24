import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const message = 'SourceMesh offline boundary blocked a network call';

function denyNetworkAccess() {
  throw new Error(message);
}

function replaceMethod(target, method, replacement = denyNetworkAccess) {
  if (!Reflect.set(target, method, replacement)) {
    throw new Error(`Unable to install offline guard for ${method}`);
  }
}

function replaceMatchingMethods(target, predicate) {
  for (const method of Object.getOwnPropertyNames(target)) {
    if (predicate(method) && typeof target[method] === 'function') {
      replaceMethod(target, method);
    }
  }
}

const fixedDotnetHost = 'C:\\Program Files\\dotnet\\dotnet.exe';
const fixedRoslynHelper = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools/sourcemesh-roslyn/bin/Release/net10.0/sourcemesh-roslyn.dll',
);
const originalSpawn = childProcess.spawn;

function isFixedRoslynSpawn(command, args, options) {
  return (
    process.platform === 'win32' &&
    command === fixedDotnetHost &&
    Array.isArray(args) &&
    args.length === 1 &&
    args[0] === fixedRoslynHelper &&
    options !== null &&
    typeof options === 'object' &&
    options.shell === false &&
    Array.isArray(options.stdio) &&
    options.stdio.length === 3 &&
    options.stdio.every((entry) => entry === 'pipe')
  );
}

function guardedSpawn(command, args, options) {
  if (!isFixedRoslynSpawn(command, args, options)) denyNetworkAccess();
  return originalSpawn.call(childProcess, command, args, options);
}

const isDnsNetworkMethod = (method) =>
  method.startsWith('lookup') ||
  method.startsWith('resolve') ||
  method === 'reverse';

const guardedMethods = [
  [
    childProcess,
    ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawnSync'],
  ],
  [dgram, ['createSocket']],
  [http, ['get', 'request']],
  [http2, ['connect']],
  [https, ['get', 'request']],
  [net, ['connect', 'createConnection']],
  [tls, ['connect']],
];

for (const [module, methods] of guardedMethods) {
  for (const method of methods) {
    replaceMethod(module, method);
  }
}

replaceMethod(childProcess, 'spawn', guardedSpawn);

for (const method of ['bind', 'connect', 'send']) {
  replaceMethod(dgram.Socket.prototype, method);
}

replaceMatchingMethods(dns, isDnsNetworkMethod);
replaceMatchingMethods(dns.promises, isDnsNetworkMethod);
replaceMatchingMethods(dns.Resolver.prototype, isDnsNetworkMethod);
replaceMatchingMethods(dns.promises.Resolver.prototype, isDnsNetworkMethod);

replaceMethod(net.Socket.prototype, 'connect');
replaceMethod(net.Server.prototype, 'listen');
replaceMethod(globalThis, 'fetch');
replaceMethod(globalThis, 'WebSocket');

syncBuiltinESMExports();
