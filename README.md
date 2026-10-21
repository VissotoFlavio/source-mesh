# SourceMesh

SourceMesh is an experimental, local-first project for building a deterministic structural graph of source code. Its goal is to give developers and software agents a compact view of code structure and relationships without sending repository data to a hosted service.

The repository currently contains only the TypeScript project scaffold and its quality tooling. It does **not** yet analyze repositories, build a graph, persist data, provide visualizations, expose an MCP server, or integrate with an AI provider.

## Privacy boundary

SourceMesh repository analysis is required to run locally and without runtime network access. SourceMesh itself must not transmit source code, file paths, graph data, derived metadata, prompts, or analysis results through telemetry, logging, analytics, tracing, error reporting, hosted language models, or visualization services.

Installing development dependencies can contact the npm registry. That installation traffic is separate from future repository analysis. Any future SourceMesh feature that requires network access must be opt-in and approved through a separate, documented decision before implementation.

These requirements cover SourceMesh itself. An editor, agent, model provider, script, or other external consumer of SourceMesh output has its own data-processing and network boundary. Review that consumer independently before giving it repository information or generated graph data.

## Local development

Prerequisites:

- Node.js 22 or 24
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
npm run pack:check
```

After a build, the current placeholder CLI can be run locally:

```sh
node dist/cli.js
```

It only prints the project name; it does not inspect a repository.

## Project status

SourceMesh is pre-release and its graph model and public interfaces are not defined. Package publication, releases, hosted processing, and compatibility changes require separate authorization and issue-backed work.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [the technical baseline](docs/decisions/0001-technical-baseline.md) for the current stack decision.

## License

Licensed under the [Apache License 2.0](LICENSE).
