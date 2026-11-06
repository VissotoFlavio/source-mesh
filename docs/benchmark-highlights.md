# SourceMesh benchmark highlights

## Main message

> SourceMesh — Give AI agents a map of your code before making them explore the repository.

SourceMesh provides a local, immutable structural snapshot that an MCP client can query for symbols and proven direct local relationships. It is not a replacement for reading code, tests, compilers, language servers, or semantic analysis beyond the evidence in its snapshot.

## A small comparison

```text
Conventional investigation
question -> search text -> open candidate files -> infer direct callers

SourceMesh investigation (after snapshot preparation)
question -> searchSymbols -> listCallers -> bounded direct-call result
```

The second flow has a preparation cost. It is most relevant when several bounded questions reuse the same local snapshot, not as a universal replacement for a one-off textual lookup.

## Publish only measured results

Use the JSON report from `npm run benchmark` or `node dist/benchmarks/cli.js` as the source for a result table. Always include the suite, fixture revision, Node, OS, run count, cold/warm state, baseline definition, and the metric origin.

| Claim                              | Publication rule                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fewer operations or files examined | Publish only with the scenario output and baseline procedure.                                                 |
| Faster workflow                    | Include preparation, MCP initialization, query count, and raw samples.                                        |
| Better precision or recall         | Include the independent ground truth and partial/unresolved cases.                                            |
| Fewer tokens                       | Publish only provider-reported or clearly labeled tokenizer-estimated values from a controlled agent A/B run. |

Do not turn returned bytes into tokens, turn a warm MCP call into end-to-end latency, or present direct dependencies as transitive application impact.

## Useful scenarios

- Navigating an unfamiliar repository with repeated symbol questions.
- Locating declarations while distinguishing duplicated names.
- Checking proven direct callers and callees.
- Inspecting direct local file dependencies before a bounded change.
- Giving an agent constrained structural context before it decides which code to read in detail.

## Limitations worth saying aloud

SourceMesh analyzes an explicit local source boundary. It does not prove runtime behavior, dynamic dispatch, package behavior, external calls, compilation success, tests, or full impact analysis. A connected MCP host/model remains a separate privacy boundary. See [the benchmark methodology](benchmarks.md) for the exact fixture, baseline, ground truth, and reproduction procedure.
