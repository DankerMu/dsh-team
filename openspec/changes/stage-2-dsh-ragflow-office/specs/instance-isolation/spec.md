## MODIFIED Requirements

### Requirement: 已知边界写明

平台 MUST 在文档里列出本阶段不提供的隔离，至少包括：共用的模型密钥在实例内可读；实例可以访问宿主机所在内网的其他地址；Document Server 的 JWT 密钥在实例内可读；员工可以在自己实例内安装插件、开启的联网工具可以访问外网。文档 MUST 写明开放插件安装入口和联网工具不改变隔离边界：员工本来就有终端和完全访问权限，插件只在员工自己的实例内运行。

#### Scenario: 文档与实际一致

- **WHEN** 阅读部署文档的隔离一节并对照隔离测试
- **THEN** 测试断言的每条边界文档里都有，文档里列为“不提供”的每一项测试都没有断言它成立

#### Scenario: 共享对端写入边界清单

- **WHEN** 阅读部署文档的隔离一节
- **THEN** 文档列出 Document Server 是除平台外唯一接入各实例网络的对端，并说明跨用户取文件由每实例文件令牌密钥阻止

### Requirement: 实例不暴露宿主端口

部署状态下，实例 MUST NOT 发布任何宿主机端口。

#### Scenario: 从宿主机外访问实例端口

- **WHEN** 两个实例运行时检查各容器的端口映射
- **THEN** 实例容器没有任何端口映射；本部署发布的宿主端口只有平台的一个

#### Scenario: 默认网络方式由平台直连实例

- **WHEN** 未指定上游方式并通过配置的平台容器启动一个实例
- **THEN** 平台容器接入该实例的独立网络，可访问其验证过的容器IPv4地址3080端口，实例没有任何宿主端口映射

#### Scenario: 停止实例仅断开其平台网络端点

- **WHEN** 停止网络方式的实例
- **THEN** 平台从该实例网络断开、该实例记录中的 Document Server 端点也被断开，空网络被删除；数据卷、平台和 Document Server 的其他网络以及其他实例保持不变

#### Scenario: 平台端点身份或连接结果不可信

- **WHEN** 配置的平台容器身份不匹配、网络出现既不是已验证平台端点也不是已记录 Document Server 端点的不明端点，或接入与清理未确认成功
- **THEN** 生命周期明确失败，不发布成功就绪或停止结果，不强制删除不明端点或资源

#### Scenario: 宿主机开发显式选择回环发布

- **WHEN** 平台在宿主机运行并显式选择published-loopback方式
- **THEN** 仅在127.0.0.1随机端口发布实例3080，不接入平台容器和 Document Server；此开发方式不声称满足部署的无宿主端口要求

## ADDED Requirements

### Requirement: 只有平台和 Document Server 能访问实例

除平台容器和自带 Document Server 外，任何容器 MUST NOT 接入员工实例网络；员工实例之间网络 MUST 仍不可达，Document Server 接入 MUST NOT 让一个实例经它的网络到达另一个实例。

#### Scenario: 检查实例网络端点

- **WHEN** 使用自带 Document Server 且两个实例均已接入并就绪时，检查各自网络的端点
- **THEN** 每个网络恰好有该员工容器、平台和 Document Server 三个端点

#### Scenario: 从 B 的实例访问 A 的实例仍失败

- **WHEN** Document Server 已接入 A 和 B 的网络，在 B 的实例里向 A 的固定地址 3080 和其他常见端口发起连接
- **THEN** 全部连接失败

### Requirement: 不能借 Document Server 读取他人文件

一个员工 MUST NOT 能借 Document Server 读取、覆盖另一个员工实例里的文件，即使该员工知道 Document Server 的 JWT 密钥、对方实例地址和文件路径。实例 MUST 只接受由本实例文件令牌密钥签发的取文件令牌和派生的文档 key。

#### Scenario: 伪造文件令牌被拒绝

- **WHEN** B 用公开源码中的默认文件令牌密钥或自己实例的文件令牌密钥，为 A 实例中的某个文件签发令牌，再让 Document Server 去拉取 A 实例的文件接口
- **THEN** A 实例拒绝该请求，Document Server 拿不到文件内容

#### Scenario: 跨实例回调被拒绝

- **WHEN** B 用 Document Server 的 JWT 密钥签名一个回调，指向 A 实例的回调接口和 B 自己的文档 key，或者伪造 A 文档的 key
- **THEN** A 实例不保存任何内容，A 的文件字节不变

#### Scenario: 猜测的文档 key 被拒绝

- **WHEN** B 已知 A 实例的 host 和某文件路径，用按公开算法推算或猜测的文档 key，经 Document Server 向 A 的回调接口提交保存，或让编辑器以该 key 打开 A 的文件
- **THEN** A 实例拒绝回调和打开请求，A 的文件字节不变，B 得不到文件内容

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
