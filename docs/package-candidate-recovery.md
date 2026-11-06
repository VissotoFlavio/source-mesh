# Immutable package candidates

The `Generate immutable package candidate` check creates a private GitHub
Pre-release only after the repository owner comments `/generate-candidate` on
an open, same-repository `release/<SemVer>` or
`hotfix/<issue-id>-<slug>` pull request to `master`. Opening or updating a pull
request never generates a package by itself. The check is an artifact-generation
workflow: it does not publish to npm, deploy software, or process an
application repository.

## Authorization and guards

Only the repository owner can add the exact comment `/generate-candidate` to an
eligible pull request. The workflow fails before creating a tag, release, or
asset unless all of the following are true:

- the pull request is open, targets `master`, and its head belongs to this
  repository;
- a release branch's SemVer, or a hotfix branch's declared package SemVer, and
  both lockfile roots and exactly one dated changelog heading agree;
- `package.json#private` is `true`;
- the current head SHA has a successful CI workflow containing the Node 22,
  Node 24, and Windows package jobs; and
- no review thread is unresolved.

The workflow captures the head SHA before building and verifies it again before
publication. A push to the release branch during the run therefore requires a
new successful CI run and a new authorized command.

## Result and evidence

The Windows build runs the offline helper and real package-install gates, then
creates `npm pack` output from the captured SHA. The workflow computes a
SHA-256 checksum and publishes the tarball plus `<tarball>.sha256` in the
GitHub Pre-release `v<version>`, with the tag targeting that exact SHA.

The workflow summary and the outcome comment on the triggering release or
hotfix pull request contain only the version, SHA, gate outcomes, digest, asset
URLs, and workflow run URL. They must never contain source snapshots, analyzed
repository data, credentials, absolute private paths, or raw command output. A
successful comment identifies the exact candidate and both release assets; a
failed comment contains only a concise stage status and the workflow run URL.

## Recovery

Re-running the command for the same SHA is successful only when the existing
pre-release contains exactly the expected tarball and checksum assets, both with
the expected digests and tag/SHA. The workflow never overwrites an asset. A tag,
release, missing asset, extra asset, or digest for a different candidate fails
closed; choose a new beta version for changed candidate content, as required by
the beta promotion policy.

If publication stops after creating a draft release, investigate the recorded
SHA and uploaded asset names. Do not delete or replace it automatically. An
authorized release owner may either complete the matching candidate manually or
follow the incident procedure and prepare a new version. Do not reuse a version
for different content. When the pull-request outcome comment reports a failure,
use its workflow run URL to inspect the authorized workflow logs before taking
recovery action; the comment intentionally does not expose failure output.
