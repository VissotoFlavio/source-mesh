import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const message = 'SourceMesh offline boundary blocked a network call';

function denyNetworkAccess() {
  throw new Error(message);
}

const guardedMethods = [
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
    Reflect.set(module, method, denyNetworkAccess);
  }
}

Reflect.set(globalThis, 'fetch', denyNetworkAccess);
Reflect.set(globalThis, 'WebSocket', denyNetworkAccess);
