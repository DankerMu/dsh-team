# Office Agents Specification

## Purpose

Define native office Agent delegation behavior so a general-office parent creates a genuine writer child with durable effective preset identity, isolated capability scope and unchanged managed permissions and lifecycle ownership.

## Requirements

### Requirement: Native writer child composition precedes work

A fresh direct one-shot child delegated by office-general MUST use the office-writer preset before its first turn. Its effective identity, instructions and tools MUST agree; its actual parent linkage and workspace MUST remain intact. Creation metadata MUST NOT be falsified to represent a later selection.

#### Scenario: General delegates a fresh writer child

- **WHEN** office-general starts a fresh direct unseeded one-shot child
- **THEN** the child has genuine subagent origin and parent linkage, selects office-writer before starting its turn, and uses writer instructions and tools without the general delegation tool
- **AND** the parent and concurrently active siblings keep their independent presets

#### Scenario: Writer cannot be activated

- **WHEN** the required writer preset is missing or broken
- **THEN** creation fails without executing the task under general or falsely reporting successful delegation

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
