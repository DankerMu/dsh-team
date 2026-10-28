## MODIFIED Requirements

### Requirement: 已知边界写明

平台 MUST 在文档里列出本阶段不提供的隔离，至少包括：共用的模型密钥在实例内可读；实例可以访问宿主机所在内网的其他地址；Document Server 的 JWT 密钥在实例内可读；员工可以在自己实例内安装插件、开启的联网工具可以访问外网。文档 MUST 写明开放插件安装入口和联网工具不改变隔离边界：员工本来就有终端和完全访问权限，插件只在员工自己的实例内运行。

#### Scenario: 文档与实际一致

- **WHEN** 阅读部署文档的隔离一节并对照隔离测试
- **THEN** 测试断言的每条边界文档里都有，文档里列为“不提供”的每一项测试都没有断言它成立

#### Scenario: 共享对端写入边界清单

- **WHEN** 阅读部署文档的隔离一节
- **THEN** 文档列出 Document Server 是除平台外唯一接入各实例网络的对端，并说明跨用户取文件由每实例文件令牌密钥阻止

## ADDED Requirements

### Requirement: 只有平台和 Document Server 能访问实例

除平台容器和自带 Document Server 外，任何容器 MUST NOT 接入员工实例网络；员工实例之间网络 MUST 仍不可达，Document Server 接入 MUST NOT 让一个实例经它的网络到达另一个实例。

#### Scenario: 检查实例网络端点

- **WHEN** 两个实例均已就绪时检查各自网络的端点
- **THEN** 每个网络只有该员工容器、平台和 Document Server 三个端点

#### Scenario: 从 B 的实例访问 A 的实例仍失败

- **WHEN** Document Server 已接入 A 和 B 的网络，在 B 的实例里向 A 的固定地址 3080 和其他常见端口发起连接
- **THEN** 全部连接失败

### Requirement: 不能借 Document Server 读取他人文件

一个员工 MUST NOT 能借 Document Server 读取、覆盖另一个员工实例里的文件，即使该员工知道 Document Server 的 JWT 密钥和对方实例地址。

#### Scenario: 伪造文件令牌被拒绝

- **WHEN** B 用公开源码中的默认文件令牌密钥或自己实例的文件令牌密钥，为 A 实例中的某个文件签发令牌，再让 Document Server 去拉取 A 实例的文件接口
- **THEN** A 实例拒绝该请求，Document Server 拿不到文件内容

#### Scenario: 跨实例回调被拒绝

- **WHEN** B 用 Document Server 的 JWT 密钥签名一个回调，指向 A 实例的回调接口和 B 自己的文档 key，或者伪造 A 文档的 key
- **THEN** A 实例不保存任何内容，A 的文件字节不变

#### Scenario: 他人实例的配置接口不可用

- **WHEN** B 从自己的实例直接请求 A 实例的 ONLYOFFICE 配置接口
- **THEN** 连接失败或被 DSH 鉴权拒绝，得不到任何文件令牌

### Requirement: 平台代理只认对应实例

平台的实例专用接口 MUST 只接受与请求来源地址相符的实例令牌：令牌必须对应一条运行中的实例记录，且请求来源地址必须等于该实例的固定地址。

#### Scenario: 用他人令牌请求

- **WHEN** B 的实例拿到 A 的实例令牌后从 B 的地址请求平台的知识库接口
- **THEN** 返回 401，不返回任何知识库数据，不按 A 的身份记录

#### Scenario: 无令牌或过期令牌

- **WHEN** 请求不带令牌、带格式错误的令牌，或带实例已停止后的旧令牌
- **THEN** 返回 401

#### Scenario: 平台会话不能访问实例接口

- **WHEN** 浏览器带员工自己的平台会话直接请求实例专用接口
- **THEN** 返回 401
