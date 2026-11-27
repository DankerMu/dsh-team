# knowledge-base Specification

## Purpose

镜像预装的「知识库」DSH 插件：员工在左侧栏只读浏览知识库，在输入区按 Session 选择检索范围，Agent 用检索工具在本轮快照的范围内检索并展示来源。插件经实例令牌访问平台代理，不接触 RAGFlow 密钥和检索参数。

## Requirements

### Requirement: 插件随镜像交付且不接触 RAGFlow 凭据

「知识库」插件 MUST 预装在用户镜像中，归 root 所有、员工不可写。它是插件目录中的可管理项，启用状态 MUST 完全服从目录三态（`employee`、`forced-on`、`forced-off`）。插件 MUST 只通过平台代理访问 RAGFlow，使用从环境变量读取的实例令牌和覆盖层给出的平台地址。插件的代码、配置、页面和 Session 数据中 MUST NOT 出现 RAGFlow 地址、密钥或检索参数。

#### Scenario: 插件文件只读

- **WHEN** 员工在终端尝试修改或删除插件目录中的文件
- **THEN** 操作因权限被拒绝，插件内容不变

#### Scenario: 启用状态服从目录

- **WHEN** 管理员把知识库设为 `forced-off` 并重启员工实例
- **THEN** 员工工作台中没有知识库面板、范围控件和检索工具，员工无法在插件页打开它

#### Scenario: 实例内找不到 RAGFlow 密钥

- **WHEN** 在员工容器内检查环境变量、覆盖层、插件目录和浏览器页面资源
- **THEN** 都不包含 RAGFlow 密钥或地址

### Requirement: 左侧栏知识库面板

插件 MUST 在左侧栏提供「知识库」面板，只读展示知识库名称和库内文件名，支持按库名搜索、按文件名筛选、分页和刷新。面板 MUST 区分五种状态：加载中、空库、无匹配、失败可重试、知识库未配置（代理返回 `not-configured` 时）。浏览操作 MUST NOT 改变检索范围。

#### Scenario: 浏览库和文件

- **WHEN** 员工打开面板、展开某个库，并按文件名筛选
- **THEN** 面板显示该库中名称匹配的文件，超过一页时可以翻页

#### Scenario: 五种状态可区分

- **WHEN** 分别遇到列表加载中、库内没有文件、搜索没有匹配、代理返回 `timeout`/`unavailable`/`upstream-error`、代理返回 `not-configured`
- **THEN** 面板分别显示加载中、空库、无匹配、失败可重试、知识库未配置，文案互不相同；知识库未配置时不显示空列表也不提供无意义的重试

#### Scenario: 浏览不改变范围

- **WHEN** 员工在面板中展开或筛选某个未选中的库
- **THEN** 输入区显示的检索范围不变

### Requirement: 按 Session 选择检索范围

输入区 MUST 提供范围控件，显示当前 Session 的检索范围，并支持多选、全选和取消全选。新 Session 的默认范围 MUST 为全选。选择 MUST 持久化在该 Session 中，刷新页面、重开浏览器和重启实例后恢复，且 MUST NOT 影响其他 Session 或其他用户。

#### Scenario: 新 Session 默认全选

- **WHEN** 员工新建 Session
- **THEN** 范围控件显示全部知识库已选中

#### Scenario: 选择按 Session 隔离并可恢复

- **WHEN** 员工在 Session 1 只选库1，切到 Session 2，然后刷新页面回到 Session 1
- **THEN** Session 2 仍是自己的选择，Session 1 恢复为只选库1

### Requirement: 提交时快照本轮范围

员工每次提交任务时，插件 MUST 把当时的范围固定为本轮的检索范围。之后对范围的修改 MUST 只影响后续任务。范围为空（员工取消全部）时，本轮检索工具 MUST NOT 发起检索，并告知 Agent 当前没有可检索的知识库。

#### Scenario: 提交后修改不影响进行中的任务

- **WHEN** 员工选库1 提交任务，任务运行期间把范围改成库2
- **THEN** 该任务的所有检索只针对库1，下一次提交的任务才使用库2

#### Scenario: 取消全部后不检索

- **WHEN** 员工取消全部知识库后提交任务，Agent 调用检索工具
- **THEN** 插件不向平台发检索请求，工具结果说明没有选择知识库

### Requirement: 子 Agent 继承根 Session 的本轮范围

子 Agent 调用检索工具时，插件 MUST 沿父 Session 关系找到根 Session，使用根 Session 本轮快照的范围。子 Agent MUST NOT 扩大范围。

#### Scenario: 委派的子 Agent 用同一范围

- **WHEN** 根 Session 本轮范围是库1，综合办公委派给公文与材料写作，子 Agent 调用检索工具
- **THEN** 检索请求只包含库1

### Requirement: 来源展示与错误提示

检索结果 MUST 向员工展示片段、文件名和所属知识库；页码和位置只在有值时显示。被剔除的知识库 MUST 提示员工。`no-results` 和每个失败取值（`invalid-request`、`not-configured`、`timeout`、`unavailable`、`upstream-error`）MUST 各有一条互不相同的中文提示。知识库不可用时，工作台其他功能 MUST 不受影响。

#### Scenario: 被剔除的库有提示

- **WHEN** 本轮范围中的一个库已被管理员在 RAGFlow 删除，Agent 发起检索
- **THEN** 结果中提示该库已不可用并被跳过，其余库的结果正常展示

#### Scenario: 不同错误有不同提示

- **WHEN** 检索分别得到 `no-results`、`invalid-request`、`not-configured`、`timeout`、`unavailable`、`upstream-error`
- **THEN** 员工看到六条互不相同的中文提示，对话可以继续

### Requirement: 知识库面板的展示与 DSH 侧栏一致

「知识库」面板 MUST 使用 DSH 的样式变量，在浅色和深色主题下都可读。

- 每个库 MUST 显示为一行，带展开标记，默认折叠。
- 展开后 MUST 显示该库当前列表的文件数（有文件名筛选时为匹配数）、文件名筛选和不带项目符号的文件行。
- 只有一页时 MUST NOT 显示翻页控件。
- 展示的变化 MUST NOT 增加请求，也 MUST NOT 改变面板的状态、文案和行为。

#### Scenario: 展开一个库

- **WHEN** 员工点开 `dsh-team-seed-policies`（2 个文件）
- **THEN** 该行的展开标记变为展开态，下面显示「共 2 个文件」、文件名筛选和两行文件名，不显示翻页控件；其他库保持折叠

#### Scenario: 筛选后显示匹配数

- **WHEN** 在该库中按文件名筛选 `expense`
- **THEN** 显示「共 1 个文件」和 `expense-policy.txt` 一行，不显示翻页控件

#### Scenario: 超过一页时显示翻页

- **WHEN** 某个库的文件数为 41（每页 20 个）
- **THEN** 展开后显示「共 41 个文件」「上一页」「第 1 / 3 页」「下一页」，翻页行为与原来相同

#### Scenario: 非列表状态不显示文件数

- **WHEN** 展开后文件列表处于加载中、空库、无匹配、失败或未配置状态
- **THEN** 只显示该状态原有的文案（失败时带「重试」），不显示文件数和翻页控件

### Requirement: Agent 可以列出本轮范围内的知识库和文件

插件 MUST 提供 Agent 工具 `knowledge_base_list`。

- 不指定库时，它列出本轮检索范围内的知识库名称。
- 指定库名时，它列出该库的文件名，支持文件名关键字和分页。
- 范围的确定方式 MUST 与检索工具相同：子 Agent 使用委派时记录的根 Session 范围，MUST NOT 扩大。
- 范围外的库与不存在的库 MUST 返回相同的结果。
- 结果 MUST 只包含名称，MUST NOT 包含库或文件的 ID。

#### Scenario: 问知识库里有什么

- **WHEN** 本轮范围只选了 `dsh-team-seed-policies`，员工问「知识库里有哪些文件」，Agent 先不带库名调用、再带该库名调用 `knowledge_base_list`
- **THEN** 第一次结果只有 `dsh-team-seed-policies`，第二次结果是该库的两个文件名，总数 2

#### Scenario: 范围外的库不可见

- **WHEN** 本轮范围只选了库 A，Agent 调用 `knowledge_base_list` 并指定库 B 的名称
- **THEN** 结果与指定一个不存在的库名相同，不发出 B 的文件列表请求

#### Scenario: 没有选择知识库

- **WHEN** 本轮取消了全选，Agent 调用 `knowledge_base_list`
- **THEN** 结果为本轮没有选择知识库，不发出任何请求
