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
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']],
  [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']],
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

for (const method of ['connect', 'send']) {
  replaceMethod(dgram.Socket.prototype, method);
}

for (const method of ['resolve', 'resolve4', 'resolve6', 'reverse']) {
  replaceMethod(dns.Resolver.prototype, method);
}

replaceMethod(net.Socket.prototype, 'connect');
replaceMethod(globalThis, 'fetch');
replaceMethod(globalThis, 'WebSocket');

syncBuiltinESMExports();
