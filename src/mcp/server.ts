import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type {
  GraphQueryService,
  QueryErrorV1,
  QueryResponseV1,
} from '../query.js';
import {
  callRelationRequest,
  fileRelationRequest,
  getSymbolRequest,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  QUERY_ERROR_MESSAGES,
  READ_ONLY_ANNOTATIONS,
  searchRequest,
  TOOL_SCHEMAS,
  inputValidationError,
  validateToolInput,
  type CallRelationToolInput,
  type FileRelationToolInput,
  type GetSymbolToolInput,
  type McpToolName,
  type SearchToolInput,
} from './contracts.js';

export type McpDiagnosticSink = (code: string) => void;

function asStructured(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function wireResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value),
      },
    ],
    structuredContent: asStructured(value),
    ...(isError ? { isError: true } : {}),
  };
}

function queryErrorResult(error: QueryErrorV1): CallToolResult {
  const safe: Record<string, unknown> = {
    code: error.code,
    message: QUERY_ERROR_MESSAGES[error.code],
    ...(error.field === undefined ? {} : { field: error.field }),
    ...(error.candidates === undefined ? {} : { candidates: error.candidates }),
    ...(error.totalCandidates === undefined
      ? {}
      : { totalCandidates: error.totalCandidates }),
  };
  return wireResult(safe, true);
}

function internalError(diagnostics: McpDiagnosticSink): CallToolResult {
  diagnostics('mcp_internal_error');
  return wireResult(
    {
      code: 'internal',
      message: QUERY_ERROR_MESSAGES.internal,
    },
    true,
  );
}

function queryResult(result: QueryResponseV1 | QueryErrorV1): CallToolResult {
  return 'code' in result ? queryErrorResult(result) : wireResult(result);
}

async function runTool<T>(
  toolName: McpToolName,
  input: unknown,
  execute: (validated: T) => QueryResponseV1 | QueryErrorV1,
  diagnostics: McpDiagnosticSink,
): Promise<CallToolResult> {
  try {
    const validation = await validateToolInput(toolName, input);
    if ('issues' in validation && validation.issues !== undefined)
      return queryErrorResult(
        inputValidationError(toolName, input, validation.issues),
      );
    return queryResult(execute(validation.value as T));
  } catch {
    return internalError(diagnostics);
  }
}

export function createMcpServer(
  queryService: GraphQueryService,
  diagnostics: McpDiagnosticSink = () => undefined,
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      maxToolInputElements: 64,
    },
  );

  server.registerTool(
    'searchSymbols',
    {
      title: 'Search symbols',
      description:
        'Search the pinned local graph for bounded symbol summaries.',
      inputSchema: TOOL_SCHEMAS.searchSymbols.input,
      outputSchema: TOOL_SCHEMAS.searchSymbols.output,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: SearchToolInput) =>
      runTool<SearchToolInput>(
        'searchSymbols',
        input,
        (validated) => queryService.searchSymbols(searchRequest(validated)),
        diagnostics,
      ),
  );

  server.registerTool(
    'getSymbol',
    {
      title: 'Get symbol',
      description:
        'Get one symbol and its bounded child page from the pinned graph.',
      inputSchema: TOOL_SCHEMAS.getSymbol.input,
      outputSchema: TOOL_SCHEMAS.getSymbol.output,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: GetSymbolToolInput) =>
      runTool<GetSymbolToolInput>(
        'getSymbol',
        input,
        (validated) => queryService.getSymbol(getSymbolRequest(validated)),
        diagnostics,
      ),
  );

  server.registerTool(
    'listFileDependencies',
    {
      title: 'List file dependencies',
      description:
        'List bounded direct dependencies for a file in the pinned graph.',
      inputSchema: TOOL_SCHEMAS.listFileDependencies.input,
      outputSchema: TOOL_SCHEMAS.listFileDependencies.output,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: FileRelationToolInput) =>
      runTool<FileRelationToolInput>(
        'listFileDependencies',
        input,
        (validated) =>
          queryService.listFileDependencies(
            fileRelationRequest('listFileDependencies', validated),
          ),
        diagnostics,
      ),
  );

  server.registerTool(
    'listFileDependents',
    {
      title: 'List file dependents',
      description:
        'List bounded direct dependents for a file in the pinned graph.',
      inputSchema: TOOL_SCHEMAS.listFileDependents.input,
      outputSchema: TOOL_SCHEMAS.listFileDependents.output,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: FileRelationToolInput) =>
      runTool<FileRelationToolInput>(
        'listFileDependents',
        input,
        (validated) =>
          queryService.listFileDependents(
            fileRelationRequest('listFileDependents', validated),
          ),
        diagnostics,
      ),
  );

  server.registerTool(
    'listCallers',
    {
      title: 'List callers',
      description:
        'List bounded direct callers for a function in the pinned graph.',
      inputSchema: TOOL_SCHEMAS.listCallers.input,
      outputSchema: TOOL_SCHEMAS.listCallers.output,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: CallRelationToolInput) =>
      runTool<CallRelationToolInput>(
        'listCallers',
        input,
        (validated) =>
          queryService.listCallers(
            callRelationRequest('listCallers', validated),
          ),
        diagnostics,
      ),
  );

  server.registerTool(
    'listCallees',
    {
      title: 'List callees',
      description:
        'List bounded direct callees for a function in the pinned graph.',
      inputSchema: TOOL_SCHEMAS.listCallees.input,
      outputSchema: TOOL_SCHEMAS.listCallees.output,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: CallRelationToolInput) =>
      runTool<CallRelationToolInput>(
        'listCallees',
        input,
        (validated) =>
          queryService.listCallees(
            callRelationRequest('listCallees', validated),
          ),
        diagnostics,
      ),
  );

  return server;
}
