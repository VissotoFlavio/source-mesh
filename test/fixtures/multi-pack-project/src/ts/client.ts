/* global csharpBridge */

export function invokeCsharp(value: string): string {
  // @ts-expect-error Cross-language calls are unsupported by this pack.
  return csharpBridge(value);
}
