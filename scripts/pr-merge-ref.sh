#!/usr/bin/env bash
# scripts/pr-merge-ref.sh — the PR gates' merge-ref guard (#734). On pull_request
# the checkout is the synthetic merge ref: HEAD^1 is the current base tip and
# HEAD^2 the PR head, so HEAD^1...HEAD^2 is the PR's own range and the payload's
# base.sha (not refreshed when main advances) is never needed. Exits 0 only when
# HEAD is a two-parent commit whose parents have exactly one merge base; otherwise
# prints a fixed workflow error and exits 1, so no gate reads a range it cannot
# form. With several merge bases (criss-cross history) git's three-dot diff
# silently picks one and can hide the PR's own changes, so that fails too, as do
# unrelated parents. Must run on bare macOS (bash 3.2).
set -u

if ! git rev-parse --verify --quiet 'HEAD^2^{commit}' >/dev/null ||
  git rev-parse --verify --quiet 'HEAD^3^{commit}' >/dev/null; then
  echo "::error::HEAD is not a two-parent merge ref; cannot read the PR range."
  exit 1
fi
# One base is one hex object name; a second base adds a newline, none prints nothing.
bases="$(git merge-base --all 'HEAD^1' 'HEAD^2')" || bases=""
case "$bases" in
  '' | *[!0-9a-f]*)
    echo "::error::HEAD^1 and HEAD^2 do not have exactly one merge base; cannot read the PR range."
    exit 1
    ;;
esac
