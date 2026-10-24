## ADDED Requirements

### Requirement: Restricted model worker selects SHA-bound operator-uploaded images

The restricted real-model worker SHALL look for an operator-staged image mapping only at the host-local path named by the exact approved reviewed SHA, `~/.config/dsh-team/verification-images/<sha>.json`. When no entry exists there, the worker SHALL leave `DSH_TEAM_VERIFICATION_IMAGES` unset so native image acquisition is unchanged. When any entry exists, the worker SHALL pass that path as `DSH_TEAM_VERIFICATION_IMAGES` to the `pnpm test:model` driver child only, leaving content validation to the existing verification-image adapter, which fails closed without native fallback. The selection SHALL NOT reach checkout, install or build environments, SSH/systemd arguments, GitHub secrets, or phase, execution and final receipts. If the presence check itself fails for a reason other than absence, the driver phase SHALL fail before spawning the driver.

#### Scenario: Mapping staged for the approved SHA

- **WHEN** a mapping file exists at the approved SHA's host-local path
- **THEN** the driver's `pnpm test:model` environment contains exactly that path as `DSH_TEAM_VERIFICATION_IMAGES`
- **AND** checkout, install and build environments and all worker receipts do not contain it

#### Scenario: No mapping for the approved SHA

- **WHEN** the directory is absent or holds mappings only for other SHAs
- **THEN** the driver environment carries no `DSH_TEAM_VERIFICATION_IMAGES` and native acquisition runs as before

#### Scenario: Unsafe entry is not resolved by the worker

- **WHEN** the approved SHA's path is a symlink, directory or file with unsafe permissions
- **THEN** the worker passes the path unchanged and the existing adapter rejects it without native fallback

#### Scenario: Presence check fails

- **WHEN** checking the approved SHA's path fails for a reason other than absence
- **THEN** the driver phase is recorded as failed with category `unknown` and `pnpm test:model` is not started
