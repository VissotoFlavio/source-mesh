# SourceMesh benchmarks

This document defines the official, reproducible benchmark procedure for SourceMesh. Its purpose is to measure bounded code-investigation tasks fairly; it is not a performance SLO, capacity claim, or a claim that SourceMesh replaces code reading, compilers, language servers, or tests.

## What is measured

The versioned synthetic suites compare a documented conventional baseline with an already prepared SourceMesh snapshot.

| Category                           | Conventional baseline                                                                                 | SourceMesh workflow                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Symbol discovery                   | Read every eligible source file and match declarations with an explicitly documented textual pattern. | `searchSymbols` against the local MCP snapshot.                                                                    |
| Direct callers                     | Read every eligible source file and find matching direct-call syntax.                                 | `searchSymbols`, then `listCallers`.                                                                               |
| Direct file relations (TS/JS only) | Read every eligible source file and resolve local import specifiers.                                  | `listFileDependencies` or `listFileDependents`.                                                                    |
| Preparation and warm queries       | Not applicable.                                                                                       | File discovery, snapshot analysis/writing, MCP initialization, then each query against an initialized MCP process. |

The baseline is intentionally simple, reproducible, and visible in `src/benchmarks/harness.ts`. It is not a model of every modern agent or search tool. The report records its exact operation count, number of examined files, returned byte count, and output values so that readers can judge its relevance.

## Fixtures and ground truth

`src/benchmarks/scenarios.ts` is the versioned scenario manifest. It specifies the language, question, query strategy, expected independent answer, and known limitations for every case. The TypeScript fixture is under `benchmarks/fixtures/typescript`; the C# suite reuses the existing repository-owned `test/fixtures/csharp-project` fixture.

The TypeScript/JavaScript suite exercises duplicate class names, a JavaScript symbol, direct callers, direct dependencies, and direct dependents. The C# suite exercises symbols and direct syntactically resolved callers. C# file dependencies are deliberately excluded: the current `listFileDependencies` projection derives only from `imports` and `exports`, while C# `uses` relations are namespace-level. Reporting those as direct file relations would overstate the current contract.

Expected and actual result sets are compared independently. Reports include correct results, false positives, false negatives, precision, and recall. An empty result has `precision: null`, not a fabricated zero-precision result.

## Run a benchmark

Install the locked dependencies, then run one suite. On npm versions that parse unknown `--name` arguments as npm configuration, use the extra argument separator shown below.

```sh
npm ci
npm run benchmark
npm run benchmark -- -- --runs 5 --suite typescript
npm run benchmark -- -- --runs 5 --suite csharp
```

The command builds SourceMesh, copies the selected synthetic fixture into a temporary directory, starts only local SourceMesh CLI/MCP processes with the existing network-denial preload, and removes the temporary directory afterward. It does not download repositories, execute fixture code, invoke a hosted model, or send telemetry.

Write a report only when requested:

```sh
node dist/benchmarks/cli.js --runs 5 --format json --output benchmarks/results/official-typescript.json
node dist/benchmarks/cli.js --runs 5 --suite csharp --format csv --output benchmarks/results/official-csharp.csv
```

Output paths must be repository-relative and cannot traverse upward. JSON contains raw run timings and environment metadata; CSV contains one row per strategy/scenario for easy comparison. Reports record Node, OS, SourceMesh commit, fixture commit, snapshot size, individual timings, and limitations; they do not serialize source text, temporary absolute paths, prompts, or credentials.

## Tokens and agent comparison

The deterministic suites do not invoke an AI model and therefore do not report token savings. This is intentional: bytes, characters, tokenizer estimates, and provider-reported tokens are different metrics.

An operator may import real, sanitized agent telemetry with `--token-metrics <relative-json-path>`. The file is an array of records with a scenario ID, `baseline` or `sourceMesh` mode, an explicit origin (`provider`, `tokenizer-estimate`, or `unknown`), and any available input, output, cached, reasoning, total-token, tool-call, and elapsed-time counts. It must not contain prompts, source code, paths, credentials, or other private text.

For an agent A/B run, use the same model, reasoning configuration, commit, question set, context budget, conventional tools, and completion criteria. Add the prepared SourceMesh MCP only in the SourceMesh mode. Keep cache conditions explicit and report unavailable metrics as unavailable. Hosted-model execution is opt-in operator work; it is not part of the SourceMesh runtime or CI.

## Interpretation and limits

Separate cold start from warm queries. A snapshot has a real discovery, analysis, persistence, and MCP-initialization cost; a fast MCP call alone is not the cost of SourceMesh. Compare total workflow cost only for a stated number of queries and repository boundary. The report exposes the raw values needed to calculate a break-even point for a particular workflow.

Static relationships are evidence-backed local edges only. Dynamic dispatch, external packages, unresolved/ambiguous targets, unselected projects, and transitive impact are not proven by this benchmark. Conventional tools may be faster or more appropriate for an isolated textual lookup, for arbitrary patterns outside the graph model, or when snapshot preparation cannot be amortized.

Performance samples are not CI gates. The deterministic manifest, metric, validation, and export tests are CI-suitable; host timing naturally varies with hardware and load.

## Observed result

On 2026-11-06, the TypeScript/JavaScript suite ran five times on Windows 10.0.26200 x64
with Node.js v24.13.0 and SourceMesh/fixture revision
`068cc96024e5a759ddf1a9829d76e62259f50756`. The fixture had six source files
and produced a 19,612-byte snapshot. The deterministic ground truth was fully
returned by both strategies in all five scenarios (precision and recall 1.0).

| Measurement                    |      Median |
| ------------------------------ | ----------: |
| Source discovery               |  12.3390 ms |
| Analysis and snapshot creation | 893.7418 ms |
| MCP initialization             | 796.6582 ms |
| Warm SourceMesh query          |   9.5574 ms |

The documented baseline examined six files plus its search operation in every
scenario (mean: 7 operations). The SourceMesh workflow used 1 operation for
symbol/file questions and 2 for the caller question (mean: 1.2 operations),
after the snapshot had been prepared. This observation does **not** show a time
or token reduction: on this small fixture, the baseline's in-process textual
scan was faster, and snapshot/MCP preparation dominates a one-off workflow. No
hosted model was run, so the report contains no token metrics.

## External C# project benchmark

The optional `external-csharp` suite accepts an absolute local target root and
one or more explicit root-relative `--project` values. Before analysis it uses
the C# selection contract to stage only approved `.cs` and `.csproj` files in a
temporary directory. SourceMesh never writes to, executes, restores, builds, or
tests the target project.

The suite uses the CLI's exact-selection mode internally, so a single selected
project does not expand its `ProjectReference` graph during analysis.

The scenario manifest and detailed report must be local ignored files. The
public report contains only the generic `external-csharp-medium` label and
aggregated metrics; it omits source identifiers, paths, expected values, query
values, errors, and per-run detailed scenarios.

```powershell
npm run benchmark -- -- --suite external-csharp --target-root "D:\\path\\to\\project" --project "src\\Api\\Api.csproj" --runs 5 --scenario-file benchmarks/local/scenarios.json --local-output benchmarks/local/detail.json --output benchmarks/results/external-csharp.json
```

Repeat `--project` for each intentionally selected project. The local manifest
uses the normal benchmark schema but must be curated and independently verified
by the operator; it is never committed. Agent/token comparison remains an
import-only protocol and requires separate authorization for hosted models.

Append `--diagnostics` while investigating a failed run. It writes bounded
stage, exit-code, and sanitized diagnostic-code events to stderr; it never
prints target paths, source content, queries, or expected values.

## Observed external C# result

The public [five-run report](../benchmarks/results/external-csharp-medium-rerun.json)
records an explicitly selected, single external C# application project under
the generic label `external-csharp-medium`. It contains no target source,
identifiers, absolute paths, prompts, or detailed local scenario records.

| Measurement                    |          Median |
| ------------------------------ | --------------: |
| File discovery                 |   2,273.7962 ms |
| Analysis and snapshot creation |   5,887.1876 ms |
| MCP initialization             |   1,665.9437 ms |
| Warm SourceMesh query          |       1.6218 ms |
| Snapshot size                  | 4,758,563 bytes |

The documented textual baseline examined 202 files and used 203 operations per
scenario. SourceMesh used one query operation after preparation. Across the 20
scenario runs, both strategies had recall 1.0; baseline precision was 1.0 and
SourceMesh precision was 0.875 because one query produced a false positive.
No token metrics were collected. These host-specific observations do not prove
an end-to-end workflow or token improvement; the snapshot and MCP preparation
costs remain part of any comparison.
