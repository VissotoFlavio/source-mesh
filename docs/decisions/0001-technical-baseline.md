# ADR 0001: Technical baseline

- Status: Accepted
- Date: 2026-10-21
- Issue: [#3](https://github.com/VissotoFlavio/source-mesh/issues/3)

## Context

SourceMesh needs a reproducible, cross-platform foundation for a local-first command-line tool. The initial repository has no existing application stack, so the runtime, package manager, quality tools, packaging model, and license must be decided before the project scaffold is created.

Repository analysis is required to stay on the user's machine. The runtime must not require a hosted service or transmit repository contents, source code, graph data, file paths, prompts, or derived metadata to external services.

## Decision

SourceMesh will use TypeScript with ECMAScript modules on Node.js. Supported Node.js major versions are 22 and 24. Code must not depend unconditionally on APIs unavailable in Node.js 22.

The project will use:

- npm as the package manager;
- a committed `package-lock.json` for reproducible dependency resolution;
- TypeScript for compilation and type checking;
- ESLint for static analysis;
- Prettier for formatting;
- the built-in Node.js test runner, with `tsx` for executing TypeScript tests; and
- `tsc` to produce the distributable JavaScript build.

The future package manifest will expose a `sourcemesh` executable through `package.json#bin`. The package will remain private during the experimental phase. Publishing to npm, creating releases, or distributing binaries requires separate authorization.

The project is licensed under the Apache License 2.0. The canonical license text will be added with the project scaffold.

## Compatibility policy

Application code and automation must support Windows, Linux, and macOS. Native dependencies should be avoided unless their benefit, platform support, installation behavior, and fallback strategy are documented.

Compatibility validation must exercise supported Node.js versions separately. Dropping a supported runtime or operating system requires a new decision record and an explicit compatibility change.

## Local-first and network boundary

SourceMesh runtime analysis must work without a network connection and must not send repository information to external systems. This includes direct telemetry and indirect transmission through hosted AI, logging, analytics, tracing, error reporting, or visualization services.

Downloading packages from npm during installation and development is outside the runtime analysis boundary. Any future feature that needs network access must be opt-in, document exactly what is sent, and be approved in a separate decision before implementation.

## Alternatives considered

### Python

Python has a strong parsing ecosystem, but the current development environment does not provide a usable Python toolchain or `uv`. Adopting it would add environment setup before the MVP can be scaffolded and would diverge from the approved runtime baseline.

### Rust

Rust could produce a single native executable, but it would increase implementation and contributor complexity before the MVP validates its graph model and workflows. Single-binary distribution does not justify that cost at this stage.

## Consequences

- Contributors get one package manager and one committed lockfile.
- The CLI can share types across analysis, graph, and presentation boundaries.
- Supporting Node.js 22 constrains use of newer runtime APIs.
- The local-first contract rules out convenient hosted processing unless a later, explicitly approved opt-in design changes the boundary.
- Keeping the package private prevents accidental publication while the project is experimental.

## Deferred decisions

This record does not choose parser libraries, the graph schema, persistence, visualization, MCP integration, CI implementation, release automation, or package publication. Those decisions belong to later, issue-backed work.
