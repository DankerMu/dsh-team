# Why

Issue #252 confirms that the audit sequence requests platform stop grace30s but its callback terminates Docker CLI after15s. A legitimate15–30s graceful stop can be rejected; no production failure or prior observed flake is claimed.

# What Changes

Allow an optional command deadline through the existing audit run callback. Keep ordinary observations at15s; give only the platform stop30s a45s envelope. Preserve exact ownership, exit0 inspection, restart ordering, propagation and real cleanup.

# Risk and Evidence

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded because real subprocess timeout, invocation-owned fault injection and cleanup evidence share a boundary.
Selected risk packs: script contract; concurrency/ordering; resource lifecycle; error propagation; verification compatibility.
Evidence floor: controlled real20s stop RED/GREEN through the actual audit/privacy callback; real external-process timeout and post-failure owned-resource absence; original deploy and full Docker suites on reviewed head; local check and protected CI.

# Scope

Test fixtures only. No production deadline, grace reduction, retries, ownership weakening or provider call. Do not extract an abstraction merely to test argument forwarding. Independent multi-seat review follows parent inline fixture admission under the higher single-slice delegation rule.
