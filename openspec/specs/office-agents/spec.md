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

### Requirement: 预置两个办公 Agent

每个新实例 MUST 预置 `office-general`（综合办公）和 `office-writer`（公文与材料写作）两个预设。每个预设 MUST 有稳定标识、中文名、职责说明、指令、关联的 Skills、允许的工具清单、版本和启用状态。

#### Scenario: 新 Session 的预设选择器

- **WHEN** 员工新建 Session 并打开预设选择器
- **THEN** 能看到“综合办公”和“公文与材料写作”，默认选中综合办公

#### Scenario: 预设信息完整

- **WHEN** 查看任一预设的定义
- **THEN** 标识、中文名、职责、指令、Skills、工具清单、版本、启用状态八项都有值

### Requirement: 手动指定专业 Agent 真实生效

员工新建 Session 时手动选择 `office-writer` 后，该 Session MUST 按公文写作的指令和工具执行。

#### Scenario: 手动选择公文写作生成通知

- **WHEN** 员工选择公文写作，要求“写一份关于周五下午消防演练的通知，保存为 DOCX”
- **THEN** 工作目录出现一个 DOCX 文件，能被 DOCX 解析库打开，正文包含标题、主送对象、事项、落款和日期

### Requirement: 自然语言任务由综合办公委派

在综合办公下提出属于公文写作范围的任务时，综合办公 MUST 把任务委派给公文写作能力完成，而不是只在回答里声称已委派。DOCX 验收 MUST 证明真实 writer 子 Session 对请求目标执行结构化文档构造；仅复制已完成文档 MUST NOT 算作构造。允许父提供事实或草稿，本契约不认证内容由子独立创作。原用户提示、既有权限和父后续核验编辑能力 MUST 保留。

#### Scenario: 一句话任务触发委派

- **WHEN** 员工在综合办公下提出同样的通知任务
- **THEN** 产生一个由该 Session 派生的子 Session，子 Session 使用公文写作的预设，对请求目标执行结构化 DOCX 构造，最终工作目录出现可打开的 DOCX
- **AND** 原生 Session、turn、call 与成功执行结果及父恢复前的产物关联；仅复制成品、失败、取消、其他 Session 或其他目标的构造不能替代该证据

### Requirement: 办公 Agent 没有联网工具

两个预设的工具清单 MUST NOT 包含联网搜索和网页抓取。

#### Scenario: 工具清单检查

- **WHEN** 查看两个预设在实例里实际生效的工具清单
- **THEN** 都不含联网搜索和网页抓取

### Requirement: 每个 Agent 有可执行的验收任务

每个预设 MUST 附带一个可自动执行的验收任务，用真实模型运行并检查产出文件。

#### Scenario: 运行验收任务

- **WHEN** 在配置了开发模型的环境里运行两个预设的验收任务
- **THEN** 每个任务都产出符合其检查项的真实文件；模型密钥缺失时任务明确失败，而不是跳过
