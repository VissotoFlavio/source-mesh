# Contributing to SourceMesh

SourceMesh uses issue-backed delivery, protected long-lived branches, Conventional Commits, and pull-request review. Keep each change focused on its issue and preserve the local-first privacy boundary described in the README.

## Before starting

1. Confirm that an open issue describes the delivery. Releases are the only exception and must not get an issue created solely for the release.
2. Confirm the branch base before creating a branch. A requested branch name is not confirmation of its base.
3. Update the base from its remote before creating the work branch.

## Branch workflow

| Change                 | Branch                      | Base      | Pull request target |
| ---------------------- | --------------------------- | --------- | ------------------- |
| Feature or maintenance | `feature/<issue-id>-<slug>` | `develop` | `develop`           |
| Release                | `release/<version>`         | `develop` | `master`            |
| Production hotfix      | `hotfix/<issue-id>-<slug>`  | `master`  | `master`            |

Branch names must not exceed 100 characters. Never commit directly to `develop` or `master`.

Example for an issue-backed feature after `develop` is explicitly confirmed as the base:

```sh
git checkout develop
git pull origin develop
git checkout -b feature/123-short-description
```

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/). The commit type describes the change and is independent of the branch prefix. Keep related changes together and avoid unrelated refactoring.

Examples:

```text
feat(graph): add symbol node model
fix(cli): reject an unreadable input path
docs: explain the local-only boundary
```

## Validation

Install dependencies reproducibly with `npm ci`. Before opening a pull request, inspect the final diff and run the relevant checks. The complete current gate is:

```sh
npm run check
```

It runs `format:check`, `lint`, `typecheck`, `test`, `build`, and `pack:check`. Do not commit generated `dist/`, dependency, coverage, cache, log, environment, or secret files.

## Pull requests

- Target the branch defined by the workflow table.
- Keep the scope aligned with the issue and include `Closes #<issue-number>` in the description, except for release pull requests.
- Describe the change and the validations performed with real Markdown paragraphs.
- Update `CHANGELOG.md` under `Unreleased` when the change is user- or contributor-visible.
- Address review findings and rerun only the checks affected by corrections.
- Do not merge without explicit authorization, even after reviews pass.

## Releases and hotfixes

A release branch starts from `develop` and targets `master`. Release pull requests promote already reviewed work; they do not close an artificial release issue. Tags, release publication, package publication, and deployment require separate explicit authorization.

A hotfix branch starts from `master`, targets `master`, and must reference its issue. After a hotfix is merged, the change must be backported to `develop` through the repository's governed backport process so the long-lived branches do not diverge.

## Protected operations

Do not install new dependencies, change database state, alter infrastructure or repository settings, deploy, publish packages or releases, create tags, expose repository data to external services, or perform destructive operations without explicit authorization appropriate to that action.

Repository inspection and local validation must not transmit repository contents. External tools that consume SourceMesh output need a separate privacy and data-processing review.
