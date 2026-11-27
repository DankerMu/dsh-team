## ADDED Requirements

### Requirement: The firewall holder script cases run the script under dash, the shell the image's /bin/sh links to

The firewall holder script integration cases SHALL run the holder script under dash, the shell the production image's `/bin/sh` links to, and SHALL name it explicitly. When dash is missing, the cases SHALL fail with an error naming it, and SHALL NOT fall back to another shell.

#### Scenario: A host whose /bin/sh differs from the image's

- **WHEN** the cases run on a host whose `/bin/sh` is not dash, such as macOS bash 3.2
- **THEN** the script still runs under dash, and a held case exits on its first SIGTERM

#### Scenario: dash is missing

- **WHEN** `/bin/dash` does not exist on the host
- **THEN** the case fails with an error naming `/bin/dash`, before any spawn
