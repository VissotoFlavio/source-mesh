# SourceMesh with AI Agents

This protocol evaluates whether a local SourceMesh MCP snapshot helps an AI
agent investigate real code. It is an A/B evaluation, not a claim that a
structural query equals completing an agent task. SourceMesh may have no
advantage or yield worse results.

## Status and telemetry boundary

No A/B result is published by this repository yet. Existing external C# results
measure structural discovery and snapshot cost, not Codex task completion or
token savings.

Codex does not expose a repository-safe automatic per-session metric feed to
this benchmark. Its documented account-usage API is account/daily-summary level,
not an experiment-session export. Codex can emit opt-in OpenTelemetry events,
including `response.completed` token counts and per-turn token-use metrics, but
an exporter can transmit data and needs the operator's separate authorization.
This benchmark neither reads Codex private session files nor changes its config.

Import only values from a permitted official source: a Codex session display or
exported session record, an authorized Codex OTel collection, or a provider
export for the exact session. Record input, output, cached-input, reasoning, and
total tokens; elapsed time; tool calls; files read; and received-information
bytes only when actually present. Do not add cached input to totals or infer
unavailable values.

## Reproducible procedure

1. Inspect the target statically. Create a private ignored manifest in
   `benchmarks/local/` with a fixed commit, exact model/reasoning, conventional
   tools, stable scenario IDs, and independently verified ground truth.
2. Select five real scenarios: public vehicle-listing investigation,
   implementation location, direct callers, initial impact analysis, and a
   second multi-file flow. Include a simple task and one requiring substantial
   code reading. Never execute, restore, modify, commit, or publish the target.
3. Run each in fresh independent sessions with equal prompt, model/version when
   identifiable, reasoning, target commit, conventional tools, context budget,
   safety rules, and completion criteria. Alternate order and never transfer
   discoveries or history.
4. In A (`baseline`), remove SourceMesh. In B (`sourceMesh`), permit the same
   tools plus `searchSymbols`, `getSymbol`, `listFileDependencies`,
   `listFileDependents`, `listCallers`, and `listCallees`; the agent chooses
   whether to use them.
5. Score answers independently. For the vehicle listing, verify entry point,
   endpoint, application/persistence components, response contract, filters,
   ordering, pagination, code evidence, and unproven relationships. API-only
   inspection cannot prove a route is used by a particular home page.
6. Import one sanitized execution record through
   `validateAgentBenchmarkExecutions`, then publish only the aggregate from
   `sanitizeAgentBenchmarkReport`. Keep prompts, answers, paths, raw exports,
   and ground truth local and ignored.

## Interpretation

Evaluate correctness, coverage, code evidence, limitations, false positives,
unsupported claims, tokens, time, tool calls, files read, and received data
together. A smaller number is not an efficiency result when quality is lower.

## 2026-11-06 structural MCP-use observation

One local, sequential three-scenario observation was attempted with the same
model and high reasoning setting in both modes. The MCP-enabled runs made
successful `searchSymbols`, `getSymbol`, `listCallers`, and `listCallees`
calls against a fresh, partial C# snapshot. This confirms MCP use, but it does
not establish an A/B result: all three conventional baseline runs were unable
to start their local read-only inspection tools in the host environment.

Consequently, this observation publishes no token, duration, tool-call, or
quality comparison and makes no efficiency claim. Its aggregate findings are:

| Generic scenario | Baseline validity                     | MCP use          | Classification |
| ---------------- | ------------------------------------- | ---------------- | -------------- |
| scenario-1       | invalid: local inspection unavailable | symbol discovery | not comparable |
| scenario-2       | invalid: local inspection unavailable | caller discovery | not comparable |
| scenario-3       | invalid: local inspection unavailable | callee discovery | not comparable |

Raw prompts, session events, answers, target paths, snapshot provenance, and
ground truth remain local and ignored. Re-run the baselines in a host where
the conventional read-only tools start successfully before publishing any
comparative metric.

Report cold and warm separately. Cold includes target staging, snapshot creation,
and MCP initialization. Warm starts only after an immutable snapshot and MCP
process are ready. Calculate amortization for 1, 5, 10, or 20 tasks only with
compatible measurements; otherwise label arithmetic as sensitivity modeling.

Public reports use generic scenario IDs and aggregates. They may name the model
and reasoning but never private target identifiers, commits, paths, prompts,
expected answers, responses, raw traces, credentials, or logs. Empty metrics
remain `null`/unavailable.

## Official Codex references

The [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
documents account-level token-activity summaries. The [advanced configuration
documentation](https://learn.chatgpt.com/docs/config-file/config-advanced)
documents opt-in OpenTelemetry token, tool-call, and duration metrics. Configure
or export telemetry only in an environment approved to handle target code.
