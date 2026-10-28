# Immutable package candidates

The `Generate immutable package candidate` workflow creates a private GitHub
Pre-release only from an open, same-repository `release/<SemVer>` pull request
to `master`. It is an artifact-generation workflow: it does not publish to npm,
deploy software, or process an application repository.

## Authorization and guards

Only the repository owner can add the exact comment `/generate-candidate` to an
eligible pull request. The workflow fails before creating a tag, release, or
asset unless all of the following are true:

- the pull request is open, targets `master`, and its head belongs to this
  repository;
- the release branch, `package.json`, both lockfile roots, and exactly one dated
  changelog heading use the same valid SemVer value;
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

The workflow summary contains only the version, SHA, gate outcomes, digest, and
asset URLs. It must never contain source snapshots, analyzed repository data,
credentials, absolute private paths, or raw command output.

## Recovery

Re-running the command for the same SHA is successful only when the existing
pre-release and both assets already match the expected tag, SHA, and checksum.
The workflow never overwrites an asset. A tag, release, or asset for a different
SHA or digest fails closed; choose a new beta version for changed candidate
content, as required by the beta promotion policy.

If publication stops after creating a draft release, investigate the recorded
SHA and uploaded asset names. Do not delete or replace it automatically. An
authorized release owner may either complete the matching candidate manually or
follow the incident procedure and prepare a new version. Do not reuse a version
for different content.
