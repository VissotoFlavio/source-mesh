import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import type {
  CallRelationRequestV1,
  FileRelationRequestV1,
  FunctionSelectorV1,
  GetSymbolRequestV1,
  QueryErrorV1,
  QueryResponseV1,
  SearchRequestV1,
  SearchSymbolKindV1,
  SymbolKindV1,
} from '../query.js';

export const MCP_SERVER_NAME = 'SourceMesh';
export const MCP_SERVER_VERSION = '0.0.0';
export const MCP_MAX_MESSAGE_BYTES = 1024 * 1024;

export const MCP_TOOL_NAMES = [
  'searchSymbols',
  'getSymbol',
  'listFileDependencies',
  'listFileDependents',
  'listCallers',
  'listCallees',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type SearchToolInput = Omit<SearchRequestV1, 'operation'>;
export type GetSymbolToolInput = Omit<GetSymbolRequestV1, 'operation'>;
export type FileRelationToolInput = Omit<FileRelationRequestV1, 'operation'>;
export type CallRelationToolInput = Omit<CallRelationRequestV1, 'operation'>;
export type McpToolError = Omit<QueryErrorV1, 'message'> & {
  readonly message: string;
};

const NODE_ID_PATTERN = '^n:[0-9a-f]{64}$';
const RELATIVE_PATH_PATTERN =
  '^(?!/)(?!\\\\)(?![A-Za-z]:)(?!.*\\u0000)(?!.*(?:^|/)(?:\\.{1,2})(?:/|$))(?!.*//).+$';
const CURSOR_SCHEMA = { type: 'string', maxLength: 4096 };
const LIMIT_SCHEMA = { type: 'integer', minimum: 1, maximum: 100 };
const ALLOW_PARTIAL_SCHEMA = { type: 'boolean' };
const NODE_ID_SCHEMA = { type: 'string', pattern: NODE_ID_PATTERN };
const PATH_SCHEMA = { type: 'string', pattern: RELATIVE_PATH_PATTERN };
const TEXT_SCHEMA = { type: 'string' };

const selectorProperties = {
  kind: {
    type: 'string',
    enum: [
      'module',
      'class',
      'interface',
      'function',
      'variable',
      'type',
      'parameter',
    ],
  },
  name: TEXT_SCHEMA,
  qualifiedName: TEXT_SCHEMA,
  path: PATH_SCHEMA,
  memberRole: { type: 'string', enum: ['none', 'static', 'instance'] },
  containerId: NODE_ID_SCHEMA,
} as const;

const selectorSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: selectorProperties,
} as const;

const functionSelectorSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    ...selectorProperties,
    kind: { const: 'function' },
  },
} as const;

const queryOptionsProperties = {
  limit: LIMIT_SCHEMA,
  cursor: CURSOR_SCHEMA,
  allowPartial: ALLOW_PARTIAL_SCHEMA,
} as const;

const queryResponseProperties = {
  schemaVersion: { const: 1 },
  completeness: { type: 'string', enum: ['complete', 'partial'] },
} as const;

const locationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'start', 'end'],
  properties: {
    path: PATH_SCHEMA,
    start: {
      type: 'object',
      additionalProperties: false,
      required: ['line', 'column'],
      properties: {
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
      },
    },
    end: {
      type: 'object',
      additionalProperties: false,
      required: ['line', 'column'],
      properties: {
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

const fileSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'name', 'path'],
  properties: {
    id: NODE_ID_SCHEMA,
    kind: { const: 'file' },
    name: TEXT_SCHEMA,
    path: PATH_SCHEMA,
    locations: { type: 'array', items: locationSchema },
  },
} as const;

const symbolSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'name', 'path', 'qualifiedName', 'memberRole'],
  properties: {
    id: NODE_ID_SCHEMA,
    kind: {
      type: 'string',
      enum: [
        'module',
        'class',
        'interface',
        'function',
        'variable',
        'type',
        'parameter',
      ],
    },
    name: TEXT_SCHEMA,
    path: PATH_SCHEMA,
    qualifiedName: TEXT_SCHEMA,
    memberRole: { type: 'string', enum: ['none', 'static', 'instance'] },
    locations: { type: 'array', items: locationSchema },
  },
} as const;

const nodeSummarySchema = {
  oneOf: [fileSummarySchema, symbolSummarySchema],
} as const;

function pageSchema(itemSchema: JsonSchemaType): JsonSchemaType {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'completeness', 'items', 'total', 'truncated'],
    properties: {
      schemaVersion: { const: 1 },
      completeness: { type: 'string', enum: ['complete', 'partial'] },
      items: { type: 'array', items: itemSchema },
      total: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' },
      continuation: CURSOR_SCHEMA,
    },
  };
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: {
      type: 'string',
      enum: [
        'invalid_request',
        'limit_exceeded',
        'not_found',
        'ambiguous',
        'entity_type_mismatch',
        'unsupported_schema',
        'invalid_snapshot',
        'partial_not_allowed',
        'internal',
      ],
    },
    message: TEXT_SCHEMA,
    field: {
      type: 'string',
      enum: [
        'operation',
        'query',
        'kind',
        'path',
        'containerId',
        'fileId',
        'nodeId',
        'selector',
        'function',
        'cursor',
        'limit',
        'allowPartial',
      ],
    },
    candidates: pageSchema(nodeSummarySchema),
    totalCandidates: { type: 'integer', minimum: 0 },
  },
} as const;

function responseSchema(response: JsonSchemaType): JsonSchemaType {
  return { oneOf: [response, errorSchema] };
}

function sanitizedSchema<T>(schema: JsonSchemaType): StandardSchemaWithJSON<T> {
  const standard = fromJsonSchema<T>(schema);
  const validate = standard['~standard'].validate;
  const sanitize = (
    result: StandardSchemaV1.Result<T>,
  ): StandardSchemaV1.Result<T> =>
    'issues' in result && result.issues !== undefined
      ? { issues: [{ message: 'invalid_request' }] }
      : result;
  return {
    '~standard': {
      ...standard['~standard'],
      validate: (value, options) => {
        const result = validate(value, options);
        return result instanceof Promise
          ? result.then(sanitize)
          : sanitize(result);
      },
    },
  };
}

const searchInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 256 },
    kind: {
      type: 'string',
      enum: ['class', 'interface', 'function', 'variable', 'type', 'parameter'],
    },
    path: PATH_SCHEMA,
    containerId: NODE_ID_SCHEMA,
    ...queryOptionsProperties,
  },
} as const;

const getSymbolInputSchema = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['nodeId'], not: { required: ['selector'] } },
    { required: ['selector'], not: { required: ['nodeId'] } },
  ],
  properties: {
    nodeId: NODE_ID_SCHEMA,
    selector: selectorSchema,
    ...queryOptionsProperties,
  },
} as const;

const fileRelationInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['fileId'],
  properties: {
    fileId: NODE_ID_SCHEMA,
    ...queryOptionsProperties,
  },
} as const;

const callRelationInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['function'],
  properties: {
    function: functionSelectorSchema,
    ...queryOptionsProperties,
  },
} as const;

const searchResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'page'],
  properties: {
    operation: { const: 'searchSymbols' },
    page: pageSchema(symbolSummarySchema),
  },
} as const;

const getSymbolResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'operation',
    'schemaVersion',
    'completeness',
    'symbol',
    'children',
  ],
  properties: {
    operation: { const: 'getSymbol' },
    ...queryResponseProperties,
    symbol: symbolSummarySchema,
    container: nodeSummarySchema,
    children: pageSchema(symbolSummarySchema),
  },
} as const;

function relationResponseSchema(
  operation:
    FileRelationRequestV1['operation'] | CallRelationRequestV1['operation'],
  itemSchema: JsonSchemaType,
): JsonSchemaType {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'page'],
    properties: {
      operation: { const: operation },
      page: pageSchema(itemSchema),
    },
  };
}

export const TOOL_SCHEMAS = {
  searchSymbols: {
    input: sanitizedSchema<SearchToolInput>(
      searchInputSchema as JsonSchemaType,
    ),
    output: sanitizedSchema<QueryResponseV1 | McpToolError>(
      responseSchema(searchResponseSchema),
    ),
  },
  getSymbol: {
    input: sanitizedSchema<GetSymbolToolInput>(
      getSymbolInputSchema as JsonSchemaType,
    ),
    output: sanitizedSchema<QueryResponseV1 | McpToolError>(
      responseSchema(getSymbolResponseSchema),
    ),
  },
  listFileDependencies: {
    input: sanitizedSchema<FileRelationToolInput>(
      fileRelationInputSchema as JsonSchemaType,
    ),
    output: sanitizedSchema<QueryResponseV1 | McpToolError>(
      responseSchema(
        relationResponseSchema('listFileDependencies', fileSummarySchema),
      ),
    ),
  },
  listFileDependents: {
    input: sanitizedSchema<FileRelationToolInput>(
      fileRelationInputSchema as JsonSchemaType,
    ),
    output: sanitizedSchema<QueryResponseV1 | McpToolError>(
      responseSchema(
        relationResponseSchema('listFileDependents', fileSummarySchema),
      ),
    ),
  },
  listCallers: {
    input: sanitizedSchema<CallRelationToolInput>(
      callRelationInputSchema as JsonSchemaType,
    ),
    output: sanitizedSchema<QueryResponseV1 | McpToolError>(
      responseSchema(
        relationResponseSchema('listCallers', symbolSummarySchema),
      ),
    ),
  },
  listCallees: {
    input: sanitizedSchema<CallRelationToolInput>(
      callRelationInputSchema as JsonSchemaType,
    ),
    output: sanitizedSchema<QueryResponseV1 | McpToolError>(
      responseSchema(
        relationResponseSchema('listCallees', symbolSummarySchema),
      ),
    ),
  },
} as const;

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const QUERY_ERROR_MESSAGES: Record<QueryErrorV1['code'], string> = {
  invalid_request: 'The query request is invalid.',
  limit_exceeded: 'The query limit is outside the allowed range.',
  not_found: 'The requested graph item was not found.',
  ambiguous: 'The selector matches multiple graph items.',
  entity_type_mismatch: 'The requested graph item has the wrong type.',
  unsupported_schema: 'The snapshot schema is unsupported.',
  invalid_snapshot: 'The snapshot is invalid.',
  partial_not_allowed:
    'The snapshot is partial and partial results are disabled.',
  internal: 'The operation could not be completed.',
};

export function searchRequest(input: SearchToolInput): SearchRequestV1 {
  return { operation: 'searchSymbols', ...input };
}

export function getSymbolRequest(
  input: GetSymbolToolInput,
): GetSymbolRequestV1 {
  return { operation: 'getSymbol', ...input };
}

export function fileRelationRequest(
  operation: FileRelationRequestV1['operation'],
  input: FileRelationToolInput,
): FileRelationRequestV1 {
  return { operation, ...input };
}

export function callRelationRequest(
  operation: CallRelationRequestV1['operation'],
  input: CallRelationToolInput,
): CallRelationRequestV1 {
  return { operation, ...input };
}

export type { FunctionSelectorV1, SearchSymbolKindV1, SymbolKindV1 };
