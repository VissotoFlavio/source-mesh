import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { DEFAULT_SNAPSHOT_PATH } from '../snapshot/path.js';
import { openValidatedSnapshot } from '../snapshot/bootstrap.js';
import { createGraphQueryService } from '../query.js';
import { MCP_MAX_REQUEST_BYTES } from './contracts.js';
import { createMcpServer, type McpDiagnosticSink } from './server.js';

export interface McpStdioHandle {
  readonly close: () => Promise<void>;
}

function stderrDiagnostic(code: string): void {
  process.stderr.write(`${code}\n`);
}

export async function runMcpStdio(
  root: string,
  snapshotPath = DEFAULT_SNAPSHOT_PATH,
  diagnostics: McpDiagnosticSink = stderrDiagnostic,
): Promise<McpStdioHandle> {
  const snapshot = await openValidatedSnapshot(root, snapshotPath);
  const queryService = Object.freeze(createGraphQueryService(snapshot));
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MCP_MAX_REQUEST_BYTES,
  });
  const serverHandle = serveStdio(
    () => createMcpServer(queryService, diagnostics),
    {
      transport,
      onerror: () => diagnostics('mcp_transport_error'),
    },
  );
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await serverHandle.close();
  };
  const onSignal = (): void => {
    void close();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { close };
}
