#!/usr/bin/env bash
# scripts/pr-merge-ref.sh — the PR gates' merge-ref guard (#734). On pull_request
# the checkout is the synthetic merge ref: HEAD^1 is the current base tip and
# HEAD^2 the PR head, so HEAD^1...HEAD^2 is the PR's own range and the payload's
# base.sha (not refreshed when main advances) is never needed. Exits 0 only when
# HEAD is a two-parent commit; otherwise prints a fixed workflow error and exits 1,
# so no gate reads a range it cannot form. Must run on bare macOS (bash 3.2).
set -u

if ! git rev-parse --verify --quiet 'HEAD^2^{commit}' >/dev/null ||
  git rev-parse --verify --quiet 'HEAD^3^{commit}' >/dev/null; then
  echo "::error::HEAD is not a two-parent merge ref; cannot read the PR range."
  exit 1
fi
