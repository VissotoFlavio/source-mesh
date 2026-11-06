# AI-agent A/B benchmark artifacts

This directory contains public, reusable protocol material only. Keep target
scenario prompts, expected answers, source paths, target commit, and raw
Codex/OTel exports under `benchmarks/local/`, which is ignored.

`src/benchmarks/agent.ts` accepts a local manifest with stable scenario IDs,
target commit, model/reasoning configuration, conventional tools, and
independently verified checks; and a list of one record per completed session.
The importer has no fields for prompt text, answers, paths, source code, traces,
or credentials. It rejects duplicate `(scenarioId, mode, workflow, repetition)`
records and records whose model, reasoning, or target commit differs from the
manifest.

Use only these generic categories in public summaries:

| Category                  | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `feature-investigation`   | Explain a real flow from entry point to response.      |
| `implementation-location` | Locate an operation without its target name.           |
| `caller-analysis`         | Identify direct, locally proven callers.               |
| `impact-analysis`         | Identify components to inspect before changing a rule. |
| `flow-investigation`      | Investigate a second multi-file feature.               |

Run the same prompt in independent Codex sessions. Keep model, reasoning, target
commit, conventional tools, context budget, safety instructions, and completion
criteria identical. In `baseline`, SourceMesh is unavailable. In `sourceMesh`,
add only its six read-only tools to that same conventional-tool set; never force
the agent to use them. Alternate mode order when practical.

Record values from `codex-session`, `codex-otel`, or `provider-export`; never
estimate tokens from characters, bytes, or tool output. Missing values become
`null` in the public report. Treat `cold` as the end-to-end workflow including
snapshot creation and MCP initialization. Use `warm` only after recording that
an immutable snapshot and MCP process were ready before timing the task.

Evaluate each answer independently against private ground truth. Record expected
and satisfied checks, evidence-backed checks, false positives, false negatives,
and unsupported claims. A lower metric is classified as `sourceMesh-lower` only
when SourceMesh quality is at least equivalent; otherwise it is
`quality-not-equivalent`.
