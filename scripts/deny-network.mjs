import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const message = 'SourceMesh offline boundary blocked a network call';

function denyNetworkAccess() {
  throw new Error(message);
}

function replaceMethod(target, method) {
  if (!Reflect.set(target, method, denyNetworkAccess)) {
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

const isDnsNetworkMethod = (method) =>
  method.startsWith('lookup') ||
  method.startsWith('resolve') ||
  method === 'reverse';

const guardedMethods = [
  [
    childProcess,
    [
      'exec',
      'execFile',
      'execFileSync',
      'execSync',
      'fork',
      'spawn',
      'spawnSync',
    ],
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
