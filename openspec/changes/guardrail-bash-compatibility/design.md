# Design

Keep the duplicate-canary JavaScript byte-identical. A top-level quoted heredoc feeds Node stdin; stdout goes to `$tmp/duplicate-lines`. `IFS= read -r duplicate_lines` consumes its newline-terminated decimal count. Node failure and read failure both exit nonzero through the existing EXIT trap. The count file belongs to the existing private temporary root, outside `$wt`; no second cleanup owner/trap or executable JS file is added.

The minimal parser result rules out JavaScript interpolation and regex tokens: neither is present in the failing literal reproduction. Outer assignment quotes are not the cause; unquoted command substitution still fails3.2. Structural removal of the nested heredoc, not word replacement, fixes the parser boundary.

Evidence: select each real shell via a temporary PATH shim containing only `bash`, invoke the unchanged root `pnpm test:guardrails`, and retain summaries plus duplicate row counts and all archive-policy cases. Keep required tools otherwise unchanged. Snapshot fixture directories and process/worktree ownership before/after; no leftover copy/count file or child is success. Preserve failed-command truth and all later canaries.

Non-goals: Bash installation/upgrades, alternate gate implementation, adding shell-specific skips, changing corpus/detector thresholds or archive policy. Rollback is the isolated shell/doc/spec revert.
