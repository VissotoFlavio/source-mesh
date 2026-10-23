import { BaseService, type ServiceContract } from './contracts.js';

export class LocalService extends BaseService implements ServiceContract {
  run(value: string): string {
    return normalize(value);
  }

  execute(value: string): string {
    return this.run(value);
  }
}

export function createService(): LocalService {
  return new LocalService();
}

export function invokeService(value: string): string {
  return createService().execute(value);
}

function normalize(value: string): string {
  return value.trim();
}
