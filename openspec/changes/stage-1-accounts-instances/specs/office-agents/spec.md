# office-agents

## Purpose

办公 Agent 是预置在每个实例里的 DSH 预设。本阶段交付综合办公和公文写作两个，用来验证预设机制和委派机制真实可用。

## ADDED Requirements

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

在综合办公下提出属于公文写作范围的任务时，综合办公 MUST 把任务委派给公文写作能力完成，而不是只在回答里声称已委派。

#### Scenario: 一句话任务触发委派

- **WHEN** 员工在综合办公下提出同样的通知任务
- **THEN** 产生一个由该 Session 派生的子 Session，子 Session 使用公文写作的预设，最终工作目录出现可打开的 DOCX

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
