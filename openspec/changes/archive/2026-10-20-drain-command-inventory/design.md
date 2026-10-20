# Design

## Context

The gate caches package script names and pipes printf into grep -q under set -euo pipefail. A successful consumer may exit before the producer completes, making producerSIGPIPE override membership. A disposable real-gate copy with16000 additional valid keys fails while its unexpanded baseline passes; the same pipeline observes141/0.

## Goals / Non-Goals

Governing invariant: every documented non-builtin command is accepted exactly when its literal complete name exists in the package script inventory; unrelated valid additions must not make an existing name disappear.

Preserve all document inputs, builtins, --silent handling, strict failure policy, missing-command diagnostics, normal command exit semantics, shell portability, guardrail case inventory/thresholds and fixture cleanup.

Non-goals: proving the original CI attempt's uncaptured signal, repairing PR300's separate Docker privacy-setup failure, changing parser grammar or manifests in the real checkout, retries, weakening gates, Docker/provider/host policy changes.

## Decisions

1. Keep the existing single implementation. Replace early-exit grep with fixed-string/full-line matching that consumes the entire input and redirects matching output to /dev/null. Do not disable pipefail or mask producer failure. This is smaller than adding an inventory parser or retry wrapper.
2. Extend the existing self-test's owned copy: add16000 valid script names, require acceptance, then explicitly restore before subsequent cases. Strengthen the existing absent-command case with a near-match script so prefixes still reject; retain all previous cases.
3. Preserve Bash3.2 grammar: literal Node heredocs remain outside command substitution. Run the root self-test through both supported interpreters and compare inventories; no platform skip.
4. Sibling audit: test-guardrails.sh's reason pipeline runs under set -u, not pipefail, so its current result is the consumer status. Do not modify it merely because its syntax looks similar; no matching false-rejection condition is established there.
5. Land this prerequisite repair independently from PR300. Then update PR300 onto main and regenerate its new-head evidence, preserving both the original CI failure and separate106/108 Docker failure.

## Risks / Trade-offs

[Draining does more work than first-match exit] → inventory is already materialized once; full consumption gives correct status without an added abstraction or new bound.
[Fixture mutation leaks into later cases] → explicit restore after the positive case and existing negative-case restore.
[Historical attribution overreach] → record actual reproduced141/0 separately from the old CI's missing signal evidence.

## Rollback

Normal reviewed revert only; no persistent schema or host changes. Human rule-file review remains deferred and UNPASSED.
