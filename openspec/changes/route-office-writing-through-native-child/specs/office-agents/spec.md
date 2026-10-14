# Spec Delta

## MODIFIED Requirements

### Requirement: Native writer child composition precedes work

When an employee requests writing or revision of an office notice or material under office-general, the general Agent MUST delegate the substantive writing to a genuine native office-writer child rather than complete the entire document itself or only claim delegation. The employee MUST NOT need to name a tool, preset or delegation mechanism. A fresh direct one-shot child delegated by office-general MUST use the office-writer preset before its first turn. Its effective identity, instructions and tools MUST agree; its actual parent linkage and workspace MUST remain intact. Creation metadata MUST NOT be falsified to represent a later selection. General coordination, ordinary file operations and subsequent verification or edits MUST remain available without changing managed permissions.

#### Scenario: Natural notice request uses the writer child

- **WHEN** an employee submits the same notice-to-DOCX request under a fresh default office-general Session that is used for manual writer acceptance
- **THEN** a genuine child of that Session uses office-writer and contributes the requested writing, and the workspace contains a readable DOCX with the supplied title, addressee, matter, issuer and date
- **AND** a completed parent-only DOCX with no child does not satisfy delegation

#### Scenario: General delegates a fresh writer child

- **WHEN** office-general starts a fresh direct unseeded one-shot child
- **THEN** the child has genuine subagent origin and parent linkage, selects office-writer before starting its turn, and uses writer instructions and tools without the general delegation tool
- **AND** the parent and concurrently active siblings keep their independent presets

#### Scenario: General retains ordinary file work and verification

- **WHEN** the task is ordinary file manipulation rather than substantive writing, or the writer child has returned its artifact for verification
- **THEN** the general Agent retains its existing file, shell and inspection capabilities and the original permission rules
- **AND** later parent verification or requested edits do not erase a genuine child's writing contribution

#### Scenario: Writer cannot be activated

- **WHEN** the required writer preset is missing or broken
- **THEN** creation fails without executing the task under general or falsely reporting successful delegation
