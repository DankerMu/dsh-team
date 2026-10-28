## ADDED Requirements

### Requirement: Writer delegation uses native preset delegation

Office-general MUST delegate writing work through DSH's native child preset delegation, with office-writer as the only child preset office-general may request for that delegation. The image-delivered office bundle MUST NOT select or rebind a child's preset after creation. Delegation by other presets and by employees MUST keep DSH's native behavior.

#### Scenario: Native delegation names the writer preset

- **WHEN** office-general delegates a notice-writing task
- **THEN** the native delegation record for the new child names office-writer as the requested preset, and the child runs under office-writer from its first turn

#### Scenario: Office-general cannot delegate to another preset

- **WHEN** office-general attempts to delegate to a preset other than office-writer
- **THEN** DSH rejects that delegation and no child runs under the other preset

#### Scenario: No post-creation rebinding

- **WHEN** a child of any preset is created, attached or resumed
- **THEN** the office bundle adds no preset selection of its own; the child's effective preset is the one native delegation assigned

### Requirement: Office delegation acceptance holds on DSH 0.2.1-rc.2

After the upgrade to DSH 0.2.1-rc.2, where every subagent child is continuable, the existing office delegation acceptance MUST hold unchanged: the effective writer, construction receipts, permission-tier effects, cold reads and resume, and cancellation and failed-creation settlement.

#### Scenario: Full re-verification after the upgrade

- **WHEN** the DSH upgrade's exact commit runs the full `pnpm test:docker`, and the separately authorized `pnpm test:model`
- **THEN** every existing office delegation case passes without skipped or relaxed cases, and both the manual writer and the natural-language delegation real-model cases pass

## MODIFIED Requirements

### Requirement: Native writer child composition precedes work

When an employee requests writing or revision of an office notice or material under office-general, the general Agent MUST delegate to a genuine native office-writer child rather than only claim delegation. For DOCX acceptance, that child MUST execute structured document construction for the requested destination through the production construction operation; copying an already-completed document MUST NOT count as construction. Parent-provided facts and drafts MAY be used. This contract proves construction by the writer Session, not independent authorship of the content. The employee MUST NOT need to name a tool, preset or delegation mechanism. A fresh direct child delegated by office-general for writing MUST run under the office-writer preset from its first turn, whatever native child mode DSH assigns. Its effective identity, instructions and tools MUST agree; its actual parent linkage and workspace MUST remain intact. Creation metadata MUST NOT be falsified to represent a different selection. General coordination, ordinary file operations and subsequent verification or edits MUST remain available without changing managed permissions.

#### Scenario: Natural notice request uses the writer child

- **WHEN** an employee submits the same notice-to-DOCX request under a fresh default office-general Session that is used for manual writer acceptance
- **THEN** a genuine child of that Session uses office-writer and executes structured DOCX construction for the requested path, and the workspace contains a readable DOCX with the supplied title, addressee, matter, issuer and date
- **AND** a completed parent-only DOCX, copy-only child, failed construction, unrelated construction or model-authored claim does not satisfy delegation

#### Scenario: General delegates a fresh writer child

- **WHEN** office-general starts a fresh direct unseeded child for a writing task
- **THEN** the child has genuine subagent origin and parent linkage, runs under office-writer before starting its turn, and uses writer instructions and tools without the general delegation tool
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

The effective writer selection MUST survive native persisted transcript reconstruction and resume. Writer delegation MUST NOT change the preset of unrelated roots, children of other presets, seeded forks, resumed Agents or children already using writer.

#### Scenario: Cold child transcript remains writer

- **WHEN** the live writer child is disposed and its native subagent address is read
- **THEN** the persisted delegation and effective preset projection identify office-writer, and the original parent relationship is still validated

#### Scenario: Resumed writer child stays writer

- **WHEN** a writer child that finished its turn is resumed with a follow-up message
- **THEN** it continues under office-writer with the same parent linkage, and the follow-up runs under the child's current permission tier

#### Scenario: Unrelated and resumed Agents retain their composition

- **WHEN** a root, other-preset child, seeded fork, resumed Agent or already-writer child is created or attached
- **THEN** writer delegation adds no new preset selection and preserves its existing composition

### Requirement: 办公 Agent 没有联网工具

联网工具开关关闭时（默认），两个预设实际生效的工具清单 MUST NOT 包含联网搜索和网页抓取。开关打开时，两个预设与其他预设遵循同一受管规则，不另作例外。

#### Scenario: 工具清单检查

- **WHEN** 联网工具开关关闭，查看两个预设在实例里实际生效的工具清单
- **THEN** 都不含联网搜索和网页抓取

#### Scenario: 管理员打开联网工具

- **WHEN** 管理员打开联网工具开关并重启实例，查看两个预设实际生效的工具清单
- **THEN** 两个预设与其他预设一样，按各自组成保留联网工具，不被覆盖层单独移除
