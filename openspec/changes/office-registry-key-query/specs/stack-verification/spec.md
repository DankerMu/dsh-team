## ADDED Requirements

### Requirement: Office 车道按路径查注册表 key 只有一份并且格式不符时失败

本机全栈 Office 车道按路径读取插件注册表 key 时 MUST 共用同一份查询。

- 注册表文件尚不存在时，MUST 视为还没写入，返回空列表。
- 文件存在但不可读，或者不符合插件 0.2.0 的格式时，查询 MUST 以非零退出。查询自身的输出只报出失败种类，不带任何 key 或路径。
- 车道 MUST 以该错误失败，不得把它当作 0 个 key。

#### Scenario: 合法注册表

- **WHEN** `registry.json` 合法，含有多个路径的记录
- **THEN** 查询按文件顺序只返回 `entry.path` 等于给定路径的 key

#### Scenario: 注册表尚未写入

- **WHEN** 员工实例里还没有 `registry.json`
- **THEN** 查询返回空列表，车道继续在期限内轮询

#### Scenario: 注册表不可读或格式不符

- **WHEN** 出现以下任一情况：
  - `registry.json` 不可读；
  - 内容不是合法 JSON；
  - `version` 不是 1；
  - `entries` 缺失或不是列表；
  - 某条记录不是对象；
  - 某条记录的 `key` 不是非空字符串；
  - 某条记录的 `entry` 不是对象；
  - 某条记录的 `entry.path` 不是字符串
- **THEN** 查询以非零退出，标准输出为空，自身输出只含失败种类
- **AND** 车道以该错误失败
