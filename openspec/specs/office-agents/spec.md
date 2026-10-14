# Office Agents Specification

## Purpose

Define native office Agent delegation behavior so a general-office parent creates a genuine writer child with durable effective preset identity, isolated capability scope and unchanged managed permissions and lifecycle ownership.

## Requirements

### Requirement: Native writer child composition precedes work

When an employee requests writing or revision of an office notice or material under office-general, the general Agent MUST delegate to a genuine native office-writer child rather than only claim delegation. For DOCX acceptance, that child MUST execute structured document construction for the requested destination through the production construction operation; copying an already-completed document MUST NOT count as construction. Parent-provided facts and drafts MAY be used. This contract proves construction by the writer Session, not independent authorship of the content. The employee MUST NOT need to name a tool, preset or delegation mechanism. A fresh direct one-shot child delegated by office-general MUST use the office-writer preset before its first turn. Its effective identity, instructions and tools MUST agree; its actual parent linkage and workspace MUST remain intact. Creation metadata MUST NOT be falsified to represent a later selection. General coordination, ordinary file operations and subsequent verification or edits MUST remain available without changing managed permissions.

#### Scenario: Natural notice request uses the writer child

- **WHEN** an employee submits the same notice-to-DOCX request under a fresh default office-general Session that is used for manual writer acceptance
- **THEN** a genuine child of that Session uses office-writer and executes structured DOCX construction for the requested path, and the workspace contains a readable DOCX with the supplied title, addressee, matter, issuer and date
- **AND** a completed parent-only DOCX, copy-only child, failed construction, unrelated construction or model-authored claim does not satisfy delegation

#### Scenario: General delegates a fresh writer child

- **WHEN** office-general starts a fresh direct unseeded one-shot child
- **THEN** the child has genuine subagent origin and parent linkage, selects office-writer before starting its turn, and uses writer instructions and tools without the general delegation tool
- **AND** the parent and concurrently active siblings keep their independent presets

#### Scenario: General retains ordinary file work and verification

- **WHEN** the task is ordinary file manipulation rather than substantive writing, or the writer child has returned its artifact for verification
- **THEN** the general Agent retains its existing file, shell and inspection capabilities and the original permission rules
- **AND** later parent verification or requested edits do not erase a genuine child's completed construction, even if final bytes change

#### Scenario: Writer cannot be activated

- **WHEN** the required writer preset is missing or broken
- **THEN** creation fails without executing the task under general or falsely reporting successful delegation

#### Scenario: Construction evidence is bound to the actual writer operation

- **WHEN** construction is evaluated
- **THEN** native Session, turn and call evidence binds successful construction to the selected writer and requested path, with the artifact observed before parent resumption
- **AND** stale, sibling, parent-only, cancelled, failed or wrong-target results and workspace-written receipt claims cannot substitute for that execution

#### Scenario: Writer constructs from a supplied draft

- **WHEN** the parent provides facts or a complete textual draft to the writer
- **THEN** structured construction by the writer can satisfy this contract, without asserting independent content authorship
- **AND** passing an existing DOCX or opaque document bytes through the operation cannot substitute for structured construction

#### Scenario: Construction preserves managed permission and execution boundaries

- **WHEN** a manual or delegated writer requests construction
- **THEN** the operation follows the existing managed permission tier and workspace execution boundary
- **AND** denial or cancellation cannot be reported as successful construction or bypassed by a direct host-side write

### Requirement: Delegation selection remains reconstructable and bounded

The effective writer selection MUST survive native persisted transcript reconstruction. The plugin MUST NOT rebind unrelated roots or presets, seeded forks, continuable children, resumed Agents or children already using writer.

#### Scenario: Cold child transcript remains writer

- **WHEN** the live one-shot child is disposed and its native subagent address is read
- **THEN** the persisted selection and effective preset projection identify office-writer, and the original parent relationship is still validated
- **AND** an immutable header retaining its earlier creation preset is not treated as the current preset

#### Scenario: Unrelated and resumed Agents retain their composition

- **WHEN** a root, other-preset child, seeded fork, continuable child, resumed Agent or already-writer child is created or attached
- **THEN** this plugin adds no new preset selection and preserves its existing composition

### Requirement: Writer selection preserves managed child authority and native lifecycle

Target-preset selection MUST preserve the child's managed permission tier, model route, cancellation and native ownership. Failed or cancelled creation MUST NOT leave a live child or unsettled owned work. Native durable metadata for a failed attempt need not be deleted.

#### Scenario: Child mutation follows its permission tier

- **WHEN** a writer child performs a real mutation under managed approval, Auto or Yolo
- **THEN** rejection produces no file effect, permitted effects follow the existing tier rules, and any approval decision belongs to that child rather than its parent

#### Scenario: Cancellation and failed creation settle

- **WHEN** a start is already cancelled, selection fails, or an active child is cancelled and disposed
- **THEN** no task runs after failed admission and native disposal settles without leaking a live child or changing parent or sibling presets
