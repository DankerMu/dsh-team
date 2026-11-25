## ADDED Requirements

### Requirement: Custody verification fixtures stay within the file size gate by responsibility

The trusted custody fixture and its integration cases SHALL be organised so that each file stays within the repository's file size gate with headroom. Generic case-deadline utilities, process-custody accounting and deadline cases SHALL each have exactly one home. Splitting SHALL NOT drop, rename or alter any verification case.

#### Scenario: Split keeps every case

- **WHEN** the custody fixture and custody cases are split by responsibility
- **THEN** the integration suite lists the same case titles as before, and every file passes the size gate with headroom
