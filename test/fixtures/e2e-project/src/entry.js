/* global missingLocalTarget */ /* E2E_SOURCE_TEXT_MARKER must never cross the graph boundary. */

import { invokeService } from './service.js';

export function main(value) {
  return invokeService(value);
}

export function unresolved(value) {
  return missingLocalTarget(value);
}
