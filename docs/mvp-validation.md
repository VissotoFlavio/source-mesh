# MVP local workflow validation

This document records the bounded end-to-end proof for issue #26. The proof uses
only the repository-owned synthetic project at `test/fixtures/e2e-project/`.
Every test copy is temporary and is removed after the run.

## What is exercised

The fixture contains:

- `src/contracts.ts`: an interface and abstract base class;
- `src/service.ts`: an implementation, extension, exports, and local calls;
- `src/entry.js`: a JavaScript entry point, a resolved call, and one deliberately
  unresolved local call;
- `generated/ignored.ts`: a unique sentinel under a reserved discovery directory;
- `tsconfig.json` and `package.json`: explicit local TypeScript/JavaScript module
  settings.

The command path is the built CLI, not an in-process replacement:

```sh
npm run build
npm run e2e:check
```

The test invokes `dist/cli.js` for analysis and queries. It loads the resulting
snapshot through the validated snapshot loader, starts `dist/cli.js mcp` over
local `stdio`, and uses the official local MCP client. The outer test harness is
allowed to create local child processes; each SourceMesh child loads
`scripts/deny-network.mjs`.

## Assertions and contracts

The test proves:

1. Discovery excludes `generated/` and does not rediscover `.sourcemesh` output.
2. The built analysis command creates a schema-v1 snapshot. Identical fixture
   content in two different absolute roots, and a repeated overwrite, produce
   byte-identical UTF-8 snapshot files.
3. The loaded graph contains containment, imports/exports, `extends`,
   `implements`, and resolved calls. The unresolved call produces the stable
   `relationship_unresolved` diagnostic and no certain call edge.
4. Snapshot bytes, CLI JSON, MCP structured results, diagnostics, and errors do
   not contain temporary absolute paths, source bodies, the ignored sentinel, or
   secret-like values.
5. The six transport mappings use the existing shared operations without a test
   normalizer or reimplemented query semantics:

| Domain operation       | CLI command    | MCP tool               |
| ---------------------- | -------------- | ---------------------- |
| `searchSymbols`        | `symbol`       | `searchSymbols`        |
| `getSymbol`            | `details`      | `getSymbol`            |
| `listFileDependencies` | `dependencies` | `listFileDependencies` |
| `listFileDependents`   | `dependents`   | `listFileDependents`   |
| `listCallers`          | `callers`      | `listCallers`          |
| `listCallees`          | `callees`      | `listCallees`          |

Each request uses `limit: 1`; the test validates the CLI envelope, MCP tool
envelope/content, and then deep-compares the shared DTO. The MCP server exposes
exactly the six read-only tools and keeps protocol frames on stdout.

The temporary malformed variant adds one syntax-error TypeScript file. The
current recoverable compiler policy creates a valid `partial` snapshot without
compiler text; queries require `--allow-partial`. The test checks the stable
partial error and a successful opt-in query. The clean fixture is also `partial`
under the current bounded NodeNext compiler host because module-resolution
package metadata outside the selected root is denied; this is why the positive
query table opts into partial results. No production behavior is changed by the
validation.

## Offline and privacy boundary

The deny-network preload rejects the representative Node HTTP, DNS, socket,
listener, WebSocket, and subprocess escape APIs. Analysis, CLI query, MCP
startup, and MCP calls all run with that preload active. This is regression
instrumentation for known Node APIs, not an operating-system sandbox or proof
against hostile native code.

SourceMesh initiates no runtime network transmission and the fixture is wholly
synthetic. A connected editor, agent, model provider, or other MCP consumer may
receive tool schemas, arguments, and bounded results and may transmit them under
its own policy. That consumer boundary must be assessed independently; local
`stdio` does not make the consumer local.

## Scope and limitations

The proof demonstrates the shipped contracts on one intentionally small fixture.
It does not claim production throughput, arbitrary-repository correctness,
latency SLOs, incremental-analysis behavior, database behavior, hosted models,
remote MCP, or OS-level isolation. Static relationship resolution is limited to
the semantics already defined by the graph implementation; unresolved or
ambiguous candidates remain diagnostics/errors rather than guessed edges.

## Measurement

Run the bounded observation manually after building:

```sh
npm run measure:e2e -- --runs 5
```

The command hard-limits the sample count to ten and reports raw per-run elapsed
milliseconds for analyze, one CLI query, and one MCP call, plus Node/OS/commit,
fixture file/node/edge counts, and snapshot bytes. It has no pass/fail latency
threshold and its output must not be converted into a scale or capacity claim.

Recorded observation (five runs, values shown to four decimal places):

- Node.js `v24.13.0`; Windows `10.0.26200`, `x64`.
- Candidate revision `ea8ec6d1959f1623b3054c173006a7bb61b619ec`.
- Fixture: 3 files, 27 nodes, 43 edges, 23,522 snapshot bytes.

| Run | Analyze ms | CLI query ms | MCP call ms |
| --: | ---------: | -----------: | ----------: |
|   1 |  1131.1222 |     771.7595 |     10.0859 |
|   2 |  1135.9104 |     728.1269 |      7.9223 |
|   3 |  1129.4401 |     731.1744 |      8.4723 |
|   4 |  1160.8683 |     743.8963 |      9.9145 |
|   5 |  1164.3326 |     730.9881 |      8.1363 |

This is one host-specific observation of the synthetic fixture, not a benchmark
or a claim about other repositories.
