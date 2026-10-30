import { Buffer } from 'node:buffer';
import process from 'node:process';

const chunks = [];

for await (const chunk of process.stdin) chunks.push(chunk);

const response = Buffer.concat(chunks).toString('utf8').trim();

process.exitCode =
  response === 'release not found' || response.includes('HTTP 404') ? 0 : 1;
