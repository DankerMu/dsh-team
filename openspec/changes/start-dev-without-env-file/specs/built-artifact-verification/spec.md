## ADDED Requirements

### Requirement: Development watch startup accepts an absent optional environment file

The foreground development command SHALL reach platform health when required configuration and runtime prerequisites are supplied without a local environment file. It SHALL retain the existing web build and native source-module reload, and SHALL use native environment-file parsing and inherited-environment precedence when the file is present. It SHALL NOT create an environment file or modify production/background entrypoints to satisfy this contract.

#### Scenario: Environment file absent at launch

- **WHEN** `pnpm dev` starts on Node24.13.1/pnpm10.34.6 without `.env`, with valid externally supplied platform configuration and a usable real Docker Engine
- **THEN** the platform reaches health without a missing-path watcher failure or creating `.env`
- **AND** a watched source change restarts the owned application and returns to health

#### Scenario: Environment file present at launch

- **WHEN** the foreground command starts with an owned nonsecret environment file
- **THEN** native loading provides its configuration, explicit inherited values retain precedence, and watched source changes still restart the application
- **AND** an existing invalid or unreadable input is not silently replaced with a missing-file fallback

#### Scenario: Foreground ownership is released

- **WHEN** the invocation is interrupted after readiness or reload
- **THEN** its native watcher and application settle and release their listener without a second application supervisor or fabricated successful shutdown
- **AND** a file first created after an env-less launch requires restarting the development command; automatic discovery of a newly created env file is not added
