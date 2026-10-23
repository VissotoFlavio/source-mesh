/* global missingLocalTarget */

import { invokeService } from './service.js';

export function main(value) {
  return invokeService(value);
}

export function unresolved(value) {
  return missingLocalTarget(value);
}
