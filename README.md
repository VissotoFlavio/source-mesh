# SourceMesh

SourceMesh is an experimental, local-first project for building a deterministic structural graph of source code. Its goal is to give developers and software agents a compact view of code structure and relationships without sending repository data to a hosted service.

The local CLI can analyze an explicitly selected TypeScript/JavaScript repository into a contained schema-v1 snapshot and query symbols, files, and direct call relationships without a hosted service.

## Privacy boundary

SourceMesh repository analysis is required to run locally and without runtime network access. SourceMesh itself must not transmit source code, file paths, graph data, derived metadata, prompts, or analysis results through telemetry, logging, analytics, tracing, error reporting, hosted language models, or visualization services.

Installing development dependencies can contact the npm registry. That installation traffic is separate from future repository analysis. Any future SourceMesh feature that requires network access must be opt-in and approved through a separate, documented decision before implementation.

These requirements cover SourceMesh itself. An editor, agent, model provider, script, or other external consumer of SourceMesh output has its own data-processing and network boundary. Review that consumer independently before giving it repository information or generated graph data.

## Local development

Prerequisites:

- Node.js 22.13 or newer within the 22.x line, or Node.js 24.x
- npm

Install the locked development dependencies:

```sh
npm ci
```

Run the complete local validation gate:

```sh
npm run check
```

The aggregate check verifies formatting, linting, types, tests, build output, and package contents. Individual commands are also available:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run offline:check
npm run pack:check
```

After a build, analyze and query a repository locally:

```sh
node dist/cli.js analyze --root /path/to/repository
node dist/cli.js symbol --root /path/to/repository --query Widget --output json
```

The default snapshot is `.sourcemesh/graph.json`. Analysis is create-only; pass
`--overwrite` to atomically replace the selected snapshot. The other commands are
`details`, `dependencies`, `dependents`, `callers`, and `callees`. Query commands
accept `--limit 1..100`, `--cursor`, and `--allow-partial`; selectors are explicit
and do not guess when they are ambiguous. Use `<command> --help` for the exact
grammar.

JSON output is a deterministic versioned envelope on stdout:

```json
{ "schemaVersion": 1, "command": "symbol", "result": {} }
```

JSON failures use the same envelope on stderr. Successful commands return `0`,
invalid arguments return `2`, typed query target/request failures return `3`, and
an existing create-only snapshot returns `4`. Operational and analysis failures
return `1`. Human output is concise and is not the automation contract.

The CLI prints only approved graph summaries, repository-relative paths, snapshot
metadata, and sanitized diagnostics. It never prints source text, absolute paths,
compiler objects, stacks, secrets, or environment data. Runtime analysis uses
filesystem and TypeScript compiler APIs only; it does not invoke Git, subprocesses,
network APIs, telemetry, or hosted services.

## Project status

SourceMesh is pre-release. Package publication, releases, hosted processing, and
compatibility changes require separate authorization and issue-backed work.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [the technical baseline](docs/decisions/0001-technical-baseline.md) for the current stack decision, and [the source graph MVP architecture](docs/decisions/0002-source-graph-mvp-architecture.md) for the accepted graph and query contracts.

## License

Licensed under the [Apache License 2.0](LICENSE).
