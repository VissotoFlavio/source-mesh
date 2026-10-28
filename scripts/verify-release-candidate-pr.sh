#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$1"
  exit 1
}

require_environment() {
  local name
  for name in REPOSITORY REPOSITORY_OWNER PULL_REQUEST_NUMBER COMMENT_AUTHOR; do
    if [[ -z "${!name:-}" ]]; then
      fail "${name} must be set."
    fi
  done
}

verify_ci() {
  local runs run_id jobs expected
  runs="$(gh run list --repo "$REPOSITORY" --workflow ci.yml --commit "$HEAD_SHA" \
    --json databaseId,status,conclusion,createdAt,event,headBranch --limit 100)"
  run_id="$(jq -r --arg branch "$HEAD_BRANCH" '
    [.[] | select(.event == "pull_request" and .headBranch == $branch)]
    | sort_by(.createdAt) | last | .databaseId // empty
  ' <<<"$runs")"
  if [[ -z "$run_id" ]]; then
    fail "No CI pull-request workflow was found for the candidate SHA."
  fi

  jobs="$(gh run view "$run_id" --repo "$REPOSITORY" --json jobs)"
  if [[ "$(jq -r '.jobs | all(.status == "completed" and .conclusion == "success")' <<<"$jobs")" != "true" ]]; then
    fail "The latest CI workflow for the candidate SHA is not fully successful."
  fi
  for expected in 'validate (Node 22.x)' 'validate (Node 24.x)' 'package (Windows x64)'; do
    if [[ "$(jq -r --arg expected "$expected" '.jobs | any(.name == $expected and .status == "completed" and .conclusion == "success")' <<<"$jobs")" != "true" ]]; then
      fail "The required CI job ${expected} did not succeed for the candidate SHA."
    fi
  done
}

verify_review_threads() {
  local query response cursor unresolved has_next
  query='query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes { isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }'
  cursor=''
  while true; do
    if [[ -z "$cursor" ]]; then
      response="$(gh api graphql -f query="$query" -F owner="$REPOSITORY_OWNER" -F name="${REPOSITORY#*/}" -F number="$PULL_REQUEST_NUMBER")"
    else
      response="$(gh api graphql -f query="$query" -F owner="$REPOSITORY_OWNER" -F name="${REPOSITORY#*/}" -F number="$PULL_REQUEST_NUMBER" -f after="$cursor")"
    fi
    unresolved="$(jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' <<<"$response")"
    if (( unresolved > 0 )); then
      fail "The candidate pull request has unresolved review threads."
    fi
    has_next="$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$response")"
    if [[ "$has_next" != "true" ]]; then
      return
    fi
    cursor="$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<<"$response")"
    if [[ -z "$cursor" || "$cursor" == "null" ]]; then
      fail "GitHub returned an invalid review-thread cursor."
    fi
  done
}

require_environment
if [[ "${COMMENT_AUTHOR,,}" != "${REPOSITORY_OWNER,,}" ]]; then
  fail "Only the repository owner may generate a package candidate."
fi

pr="$(gh api "repos/${REPOSITORY}/pulls/${PULL_REQUEST_NUMBER}")"
if [[ "$(jq -r '.state' <<<"$pr")" != "open" ||
  "$(jq -r '.base.ref' <<<"$pr")" != "master" ||
  "$(jq -r '.base.repo.full_name' <<<"$pr")" != "$REPOSITORY" ||
  "$(jq -r '.head.repo.full_name' <<<"$pr")" != "$REPOSITORY" ]]; then
  fail "The pull request is not an open same-repository release pull request targeting master."
fi

HEAD_BRANCH="$(jq -r '.head.ref' <<<"$pr")"
HEAD_SHA="$(jq -r '.head.sha' <<<"$pr")"
if [[ ! "$HEAD_BRANCH" =~ ^release/[^/]+$ || ! "$HEAD_SHA" =~ ^[[:xdigit:]]{40}$ ]]; then
  fail "The pull request head is not a valid release branch and commit SHA."
fi
if [[ -n "${EXPECTED_HEAD_SHA:-}" && "$HEAD_SHA" != "$EXPECTED_HEAD_SHA" ]]; then
  fail "The pull request head changed after candidate validation."
fi

verify_ci
verify_review_threads

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "head_branch=${HEAD_BRANCH}"
    echo "head_sha=${HEAD_SHA}"
  } >> "$GITHUB_OUTPUT"
fi
