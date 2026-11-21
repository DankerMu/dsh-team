## MODIFIED Requirements

### Requirement: 预装插件的强制状态经覆盖层下发

插件目录中的每一项属于两类之一。受管必启项（平台入口、权限档、中文界面、Office 提示）MUST 总是由覆盖层写为启用。可管理项按管理员设定的三态写入：`forced-on` 写为启用，`forced-off` 写为停用，`employee` MUST NOT 写入任何启用状态，由员工 profile 中来自镜像的默认值和员工自己的选择决定。ONLYOFFICE 插件例外：本次启动 Office 不可用时，覆盖层 MUST 把它写为停用，不论其目录状态。目录之外的插件 MUST NOT 被覆盖层写入启用状态。

#### Scenario: 强制关的插件员工打不开

- **WHEN** 管理员把一个可管理的预装插件设为 `forced-off` 并重启员工实例，员工在插件页尝试打开它
- **THEN** 该插件在实例里实际处于停用状态，重启实例后仍是停用

#### Scenario: 员工自选保留员工的选择

- **WHEN** 某预装插件为 `employee`，员工把它关掉并重启实例
- **THEN** 它仍是关闭；另一个从未改动它的员工看到的是镜像默认状态

#### Scenario: 生成器只写强制项和必启项

- **WHEN** 输入目录中有一个受管必启项，以及三个可管理项分别为 `employee`、`forced-on`、`forced-off`
- **THEN** 输出对必启项和 `forced-on` 项写为启用、对 `forced-off` 项写为停用，对 `employee` 项不写任何启用状态

#### Scenario: Office 不可用时 ONLYOFFICE 停用

- **WHEN** ONLYOFFICE 的目录状态为 `employee` 或 `forced-on`，而本次启动 Office 不可用
- **THEN** 输出把 ONLYOFFICE 写为停用，其他目录项的输出不变

#### Scenario: 强制开的 bundle 已被员工取消勾选

- **WHEN** 某可管理 bundle 为 `forced-on`，而观测到的组成中没有它规范 patch 插入的任何一行
- **THEN** 输出按原顺序写出该 bundle 规范 patch 的全部行，其中的预设条目经与观测预设相同的联网工具规则处理；若组成中只出现其中一部分行，读取器拒绝该组成，实例不启动

#### Scenario: profile 里目标不存在的行不阻止启动

- **WHEN** 员工 profile 或 home patch 里有一行，应用到该行时其 id 在此前的 bundle、profile、home 行组成中不存在（例如经 DSH 插件管理写出、指向覆盖层插入行的停用行），实例下次启动
- **THEN** 组成读取器按 DSH 语义跳过该行，实例照常启动，覆盖层状态不变；bundle 层的任何告警，以及 profile/home 层的 name mismatch、`patch insert` 目标不存在或不是 group、缺 id，以及 id 不是字符串的行，读取器仍拒绝该组成，实例不启动

#### Scenario: 目标不存在的行的 id 含行分隔符

- **WHEN** 员工 profile 或 home patch 里一行的 id 是含 U+2028 或 U+2029 的字符串，应用到该行时其 id 在此前的组成中不存在，实例下次启动
- **THEN** 组成读取器与其他字符串 id 一样跳过该行，实例照常启动，输出与不含该行时相同；id 含这些字符的 name mismatch 行和 `patch insert` 目标不存在的行，读取器仍拒绝

#### Scenario: 强制关的 bundle 覆盖了默认预设

- **WHEN** 某可管理 bundle 为 `forced-off`，其规范 patch 把预设注册表的默认预设改为它自己的预设，分别以它在观测组成中存在和缺席调用生成函数
- **THEN** 两种情况输出相同：对它插入的每一行写为停用、这些预设不再整行写出，并把预设注册表的默认预设还原为 DSH 发行默认 `standard`，使员工运行中勾选它时这些行立即生效；规范 patch 若覆盖了别的行，生成器拒绝

#### Scenario: 必启项状态异常或强制项无法激活

- **WHEN** 输入目录中某受管必启项的状态不是 `forced-on`，或某可管理项处于强制态而其规范 patch 没有任何行
- **THEN** 生成函数抛出错误，不产出覆盖层
