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
  GetSymbolRequestV2,
  QueryErrorV1,
  QueryErrorV2,
  QueryResponseV1,
  QueryResponseV2,
  QueryResponseV3,
  SearchRequestV1,
  SearchRequestV2,
  SearchSymbolKindV1,
  SymbolKindV1,
} from '../query.js';

export const MCP_SERVER_NAME = 'SourceMesh';
export const MCP_SERVER_VERSION = '0.0.0';
export const MCP_MAX_MESSAGE_BYTES = 1024 * 1024;
export const MCP_MAX_REQUEST_BYTES = 64 * 1024;
export const MCP_FRAME_OVERHEAD_BYTES = MCP_MAX_REQUEST_BYTES + 1024;

export const MCP_INITIALIZATION_INSTRUCTIONS = [
  'SourceMesh serves one existing validated local snapshot through bounded read-only queries.',
  'Do not request repository analysis, snapshot creation, deletion, or writes through this MCP server.',
  'A local operator or shell agent must create the snapshot before starting this server; the server never analyzes repositories or writes snapshots.',
  'For C#, choose exactly one selection mode: a legacy relative --solution, one relative --project, or repeatable relative --project options for an explicit selected-project snapshot.',
  'Snapshot creation is create-only. After a later analysis, start a new MCP process with its explicitly selected snapshot; a running server never reloads snapshots.',
  'See docs/csharp-mcp-snapshot-package-guide.md in this installed package for prerelease installation, MCP-host configuration, source-encoding, and diagnostic-budget guidance.',
].join(' ');

export const MCP_TOOL_NAMES = [
  'searchSymbols',
  'getSymbol',
  'listFileDependencies',
  'listFileDependents',
  'listCallers',
  'listCallees',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type SearchToolInput =
  Omit<SearchRequestV1, 'operation'> | Omit<SearchRequestV2, 'operation'>;
export type GetSymbolToolInput =
  Omit<GetSymbolRequestV1, 'operation'> | Omit<GetSymbolRequestV2, 'operation'>;
export type FileRelationToolInput = Omit<FileRelationRequestV1, 'operation'>;
export type CallRelationToolInput = Omit<CallRelationRequestV1, 'operation'>;
export type McpToolError =
  | (Omit<QueryErrorV1, 'message'> & {
      readonly message: string;
    })
  | (Omit<QueryErrorV2, 'message'> & { readonly message: string });

const NODE_ID_PATTERN = '^n:[0-9a-f]{64}$';
const RELATIVE_PATH_PATTERN =
  '^(?!/)(?!.*\\\\)(?![A-Za-z]:)(?!.*\\u0000)(?!.*(?:^|/)(?:\\.{1,2})(?:/|$))(?!.*//).+$';
const CURSOR_SCHEMA = { type: 'string', maxLength: 4096 };
const LIMIT_SCHEMA = { type: 'integer', minimum: 1, maximum: 100 };
const ALLOW_PARTIAL_SCHEMA = { type: 'boolean' };
const NODE_ID_SCHEMA = { type: 'string', pattern: NODE_ID_PATTERN };
const SCHEMA_VERSION_SCHEMA = {
  oneOf: [{ const: 1 }, { const: 2 }, { const: 3 }],
};
const PATH_SCHEMA = { type: 'string', pattern: RELATIVE_PATH_PATTERN };
const TEXT_SCHEMA = { type: 'string' };

const selectorProperties = {
  kind: {
    type: 'string',
    enum: [
      'solution',
      'project',
      'module',
      'namespace',
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
        'solution',
        'project',
        'module',
        'namespace',
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

const symbolSummaryV1Schema = {
  ...symbolSummarySchema,
  properties: {
    ...symbolSummarySchema.properties,
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
  },
} as const;

const packAttributionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'language', 'version', 'capabilities'],
  properties: {
    id: TEXT_SCHEMA,
    language: TEXT_SCHEMA,
    version: TEXT_SCHEMA,
    capabilities: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['source-analysis', 'project-manifest', 'semantic-relations'],
      },
    },
  },
} as const;
const snapshotMetadataV3Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['verification', 'packs'],
  properties: {
    verification: { const: 'unverified' },
    packs: { type: 'array', items: packAttributionSchema },
  },
} as const;
const fileSummaryV3Schema = {
  ...fileSummarySchema,
  required: [...fileSummarySchema.required, 'packId', 'language'],
  properties: {
    ...fileSummarySchema.properties,
    packId: TEXT_SCHEMA,
    language: TEXT_SCHEMA,
  },
} as const;
const symbolSummaryV3Schema = {
  ...symbolSummarySchema,
  required: [...symbolSummarySchema.required, 'packId', 'language'],
  properties: {
    ...symbolSummarySchema.properties,
    packId: TEXT_SCHEMA,
    language: TEXT_SCHEMA,
  },
} as const;
const nodeSummaryV3Schema = {
  oneOf: [fileSummaryV3Schema, symbolSummaryV3Schema],
} as const;
const relationEvidenceV3Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'packId', 'evidence'],
  properties: {
    id: { type: 'string', pattern: '^e:[0-9a-f]{64}$' },
    kind: {
      type: 'string',
      enum: [
        'imports',
        'exports',
        'extends',
        'implements',
        'calls',
        'references',
        'uses',
      ],
    },
    packId: TEXT_SCHEMA,
    evidence: { type: 'string', enum: ['semantic', 'syntactic', 'inferred'] },
  },
} as const;

const nodeSummaryV1Schema = {
  oneOf: [fileSummarySchema, symbolSummaryV1Schema],
} as const;
const nodeSummaryV2Schema = {
  oneOf: [fileSummarySchema, symbolSummarySchema],
} as const;

function pageSchema(
  itemSchema: JsonSchemaType,
  schemaVersion: JsonSchemaType = SCHEMA_VERSION_SCHEMA,
): JsonSchemaType {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'completeness', 'items', 'total', 'truncated'],
    properties: {
      schemaVersion,
      completeness: { type: 'string', enum: ['complete', 'partial'] },
      items: { type: 'array', items: itemSchema },
      total: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' },
      continuation: CURSOR_SCHEMA,
    },
  };
}

function versionedPageSchema(
  v1ItemSchema: JsonSchemaType,
  v2ItemSchema: JsonSchemaType,
): JsonSchemaType {
  return {
    oneOf: [
      pageSchema(v1ItemSchema, { const: 1 }),
      pageSchema(v2ItemSchema, { const: 2 }),
      pageSchema(nodeSummaryV3Schema, { const: 3 }),
    ],
  };
}

function legacyPageSchema(
  v1ItemSchema: JsonSchemaType,
  v2ItemSchema: JsonSchemaType,
): JsonSchemaType {
  return {
    oneOf: [
      pageSchema(v1ItemSchema, { const: 1 }),
      pageSchema(v2ItemSchema, { const: 2 }),
    ],
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
    candidates: versionedPageSchema(nodeSummaryV1Schema, nodeSummaryV2Schema),
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

interface InputContract<T> {
  readonly advertised: StandardSchemaWithJSON<T>;
  readonly validate: StandardSchemaWithJSON<T>['~standard']['validate'];
}

function inputContract<T>(schema: JsonSchemaType): InputContract<T> {
  const standard = fromJsonSchema<T>(schema);
  return {
    // The SDK validates before invoking a tool handler. Keep its advertised
    // schema strict, then run this same validator inside the boundary so a
    // failure can be returned as SourceMesh's public tool-error DTO.
    advertised: {
      '~standard': {
        ...standard['~standard'],
        validate: (value) => ({ value: value as T }),
      },
    },
    validate: standard['~standard'].validate,
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
      enum: [
        'solution',
        'project',
        'module',
        'namespace',
        'class',
        'interface',
        'function',
        'variable',
        'type',
        'parameter',
      ],
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

const inputContracts = {
  searchSymbols: inputContract<SearchToolInput>(
    searchInputSchema as JsonSchemaType,
  ),
  getSymbol: inputContract<GetSymbolToolInput>(
    getSymbolInputSchema as JsonSchemaType,
  ),
  listFileDependencies: inputContract<FileRelationToolInput>(
    fileRelationInputSchema as JsonSchemaType,
  ),
  listFileDependents: inputContract<FileRelationToolInput>(
    fileRelationInputSchema as JsonSchemaType,
  ),
  listCallers: inputContract<CallRelationToolInput>(
    callRelationInputSchema as JsonSchemaType,
  ),
  listCallees: inputContract<CallRelationToolInput>(
    callRelationInputSchema as JsonSchemaType,
  ),
} as const;

const searchResponseSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'page'],
      properties: {
        operation: { const: 'searchSymbols' },
        page: legacyPageSchema(symbolSummaryV1Schema, symbolSummarySchema),
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'metadata', 'page'],
      properties: {
        operation: { const: 'searchSymbols' },
        metadata: snapshotMetadataV3Schema,
        page: pageSchema(symbolSummaryV3Schema, { const: 3 }),
      },
    },
  ],
} as const;

const getSymbolResponseV1Schema = {
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
    schemaVersion: { const: 1 },
    completeness: { type: 'string', enum: ['complete', 'partial'] },
    symbol: symbolSummaryV1Schema,
    container: nodeSummaryV1Schema,
    children: pageSchema(symbolSummaryV1Schema, { const: 1 }),
  },
} as const;
const getSymbolResponseV2Schema = {
  ...getSymbolResponseV1Schema,
  properties: {
    ...getSymbolResponseV1Schema.properties,
    schemaVersion: { const: 2 },
    symbol: symbolSummarySchema,
    container: nodeSummaryV2Schema,
    children: pageSchema(nodeSummaryV2Schema, { const: 2 }),
  },
} as const;
const getSymbolResponseV3Schema = {
  ...getSymbolResponseV1Schema,
  required: [...getSymbolResponseV1Schema.required, 'metadata'],
  properties: {
    ...getSymbolResponseV1Schema.properties,
    schemaVersion: { const: 3 },
    metadata: snapshotMetadataV3Schema,
    symbol: symbolSummaryV3Schema,
    container: nodeSummaryV3Schema,
    children: pageSchema(nodeSummaryV3Schema, { const: 3 }),
  },
} as const;
const getSymbolResponseSchema = {
  oneOf: [
    getSymbolResponseV1Schema,
    getSymbolResponseV2Schema,
    getSymbolResponseV3Schema,
  ],
} as const;

function relationResponseSchema(
  operation:
    FileRelationRequestV1['operation'] | CallRelationRequestV1['operation'],
  v1ItemSchema: JsonSchemaType,
  v2ItemSchema: JsonSchemaType,
): JsonSchemaType {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'page'],
        properties: {
          operation: { const: operation },
          page: pageSchema(v1ItemSchema, { const: 1 }),
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'page'],
        properties: {
          operation: { const: operation },
          page: pageSchema(v2ItemSchema, { const: 2 }),
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'metadata', 'page'],
        properties: {
          operation: { const: operation },
          metadata: snapshotMetadataV3Schema,
          page: pageSchema(
            {
              type: 'object',
              additionalProperties: false,
              required: [
                'node',
                'relationships',
                'relationshipsTotal',
                'relationshipsTruncated',
              ],
              properties: {
                node:
                  operation === 'listFileDependencies' ||
                  operation === 'listFileDependents'
                    ? fileSummaryV3Schema
                    : symbolSummaryV3Schema,
                relationships: {
                  type: 'array',
                  items: relationEvidenceV3Schema,
                },
                relationshipsTotal: { type: 'integer', minimum: 0 },
                relationshipsTruncated: { type: 'boolean' },
              },
            },
            { const: 3 },
          ),
        },
      },
    ],
  };
}

export const TOOL_SCHEMAS = {
  searchSymbols: {
    input: inputContracts.searchSymbols.advertised,
    output: sanitizedSchema<
      QueryResponseV1 | QueryResponseV2 | QueryResponseV3 | McpToolError
    >(responseSchema(searchResponseSchema)),
  },
  getSymbol: {
    input: inputContracts.getSymbol.advertised,
    output: sanitizedSchema<
      QueryResponseV1 | QueryResponseV2 | QueryResponseV3 | McpToolError
    >(responseSchema(getSymbolResponseSchema)),
  },
  listFileDependencies: {
    input: inputContracts.listFileDependencies.advertised,
    output: sanitizedSchema<
      QueryResponseV1 | QueryResponseV2 | QueryResponseV3 | McpToolError
    >(
      responseSchema(
        relationResponseSchema(
          'listFileDependencies',
          fileSummarySchema,
          fileSummarySchema,
        ),
      ),
    ),
  },
  listFileDependents: {
    input: inputContracts.listFileDependents.advertised,
    output: sanitizedSchema<
      QueryResponseV1 | QueryResponseV2 | QueryResponseV3 | McpToolError
    >(
      responseSchema(
        relationResponseSchema(
          'listFileDependents',
          fileSummarySchema,
          fileSummarySchema,
        ),
      ),
    ),
  },
  listCallers: {
    input: inputContracts.listCallers.advertised,
    output: sanitizedSchema<
      QueryResponseV1 | QueryResponseV2 | QueryResponseV3 | McpToolError
    >(
      responseSchema(
        relationResponseSchema(
          'listCallers',
          symbolSummaryV1Schema,
          symbolSummarySchema,
        ),
      ),
    ),
  },
  listCallees: {
    input: inputContracts.listCallees.advertised,
    output: sanitizedSchema<
      QueryResponseV1 | QueryResponseV2 | QueryResponseV3 | McpToolError
    >(
      responseSchema(
        relationResponseSchema(
          'listCallees',
          symbolSummaryV1Schema,
          symbolSummarySchema,
        ),
      ),
    ),
  },
} as const;

const INPUT_FIELDS: Record<McpToolName, readonly string[]> = {
  searchSymbols: [
    'query',
    'kind',
    'path',
    'containerId',
    'limit',
    'cursor',
    'allowPartial',
  ],
  getSymbol: ['nodeId', 'selector', 'limit', 'cursor', 'allowPartial'],
  listFileDependencies: ['fileId', 'limit', 'cursor', 'allowPartial'],
  listFileDependents: ['fileId', 'limit', 'cursor', 'allowPartial'],
  listCallers: ['function', 'limit', 'cursor', 'allowPartial'],
  listCallees: ['function', 'limit', 'cursor', 'allowPartial'],
};

function issueField(
  toolName: McpToolName,
  input: unknown,
  issues: readonly StandardSchemaV1.Issue[],
): QueryErrorV1['field'] {
  const fields = new Set(INPUT_FIELDS[toolName]);
  for (const issue of issues) {
    const pathMatch = /^data\/([^/ ]+)/u.exec(issue.message);
    if (pathMatch !== null && fields.has(pathMatch[1]!))
      return pathMatch[1] as QueryErrorV1['field'];
    const requiredMatch = /required property '([^']+)'/u.exec(issue.message);
    if (requiredMatch !== null && fields.has(requiredMatch[1]!))
      return requiredMatch[1] as QueryErrorV1['field'];
  }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const unknown = Object.keys(input).find((key) => !fields.has(key));
    // Unknown property names are intentionally not echoed in the public DTO.
    if (unknown !== undefined) return undefined;
  }
  return undefined;
}

export async function validateToolInput(
  toolName: McpToolName,
  input: unknown,
): Promise<StandardSchemaV1.Result<unknown>> {
  const result = inputContracts[toolName].validate(input);
  return result instanceof Promise ? await result : result;
}

export function inputValidationError(
  toolName: McpToolName,
  input: unknown,
  issues: readonly StandardSchemaV1.Issue[],
): QueryErrorV1 {
  const field = issueField(toolName, input, issues);
  return {
    code: 'invalid_request',
    message: QUERY_ERROR_MESSAGES.invalid_request,
    ...(field === undefined ? {} : { field }),
  };
}

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

export function searchRequest(
  input: SearchToolInput,
): SearchRequestV1 | SearchRequestV2 {
  return { operation: 'searchSymbols', ...input };
}

export function getSymbolRequest(
  input: GetSymbolToolInput,
): GetSymbolRequestV1 | GetSymbolRequestV2 {
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
