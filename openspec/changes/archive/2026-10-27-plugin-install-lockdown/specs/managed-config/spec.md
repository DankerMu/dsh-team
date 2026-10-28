## ADDED Requirements

### Requirement: Agent 不能安装插件

每个实例里的每个预设，包括员工自己添加或改名的预设和嵌套 group，MUST NOT 包含 DSH 插件管理工具 `@deepseek-ai/dsh-plugin-manager/tools`。按包名匹配，与联网工具的去除方式相同。

受管覆盖层 MUST 把插件页的仓库探测关掉，即 `ui-plugin-manager` 的 `registryProbeEnabled: false`。这样实例运行时不会主动访问公共 npm 仓库。

#### Scenario: Agent 没有插件管理工具

- **WHEN** 员工在任一预设下要求 Agent 安装、卸载或列出插件包
- **THEN** 实际生效的预设工具里没有 `plugin_manager`，Agent 无法执行

#### Scenario: 员工改名的插件管理工具也被去掉

- **WHEN** 员工在自己的 profile 中新增一个非默认预设，其嵌套 group 里含有改了 id 的 `@deepseek-ai/dsh-plugin-manager/tools`，平台随后重新生成覆盖层并重启实例
- **THEN** 该预设实际生效时不含 `plugin_manager`，其他插件和顺序保留

#### Scenario: 生成器移除插件管理工具并关闭仓库探测

- **WHEN** 输入的预设在顶层和嵌套 group 中，以任意 id 含有 `@deepseek-ai/dsh-plugin-manager/tools` 和联网工具
- **THEN** 输出预设中两者都被移除，其他插件、顺序和预设元数据保留，输入不被修改
- **AND** 输出恰好包含一行 `{ id: 'ui-plugin-manager', config: { registryProbeEnabled: false } }`，其余各行不变
