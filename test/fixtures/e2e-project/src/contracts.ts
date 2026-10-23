// The empty contract intentionally exercises implementation resolution without
// adding unsupported interface-member identity to this MVP fixture.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServiceContract {}

export abstract class BaseService {
  abstract run(value: string): string;

  execute(value: string): string {
    return this.run(value);
  }
}
