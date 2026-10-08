# instance-isolation

## Purpose

规定用户与用户之间、用户与平台之间不可越过的边界。每一条都有自动化测试，并在之后的每个阶段继续运行。

## ADDED Requirements

### Requirement: 用户看不到他人的文件和 Session

一个用户通过界面、接口或长连接 MUST NOT 读到、列出或修改另一个用户的文件和 Session。

#### Scenario: 两个用户的同名文件互不影响

- **WHEN** 用户 A 和用户 B 各自让 Agent 在工作目录写入 `note.txt`，内容不同
- **THEN** A 读到的是 A 写的内容，B 读到的是 B 写的内容

#### Scenario: Session 列表只有自己的

- **WHEN** A 和 B 各完成一轮对话后分别查看 Session 列表
- **THEN** 各自只看到自己的 Session

#### Scenario: 用他人的 Session 标识请求

- **WHEN** B 带着自己的平台会话，用 A 的 Session 标识请求该 Session 的内容
- **THEN** 请求到达的是 B 的实例，得不到 A 的任何内容

### Requirement: 实例之间网络不可达

一个实例内的进程 MUST NOT 能与另一个实例的任何端口建立连接。

#### Scenario: 从 B 的实例连接 A 的实例

- **WHEN** 在 B 的实例里向 A 的容器地址和主机名的 3080 端口以及其他常见端口发起连接
- **THEN** 全部连接失败

#### Scenario: A 的 DSH 凭据在 B 处无用

- **WHEN** 把 A 实例的 DSH cookie 或启动令牌拿到 B 的实例上使用
- **THEN** 被拒绝

### Requirement: 实例不暴露宿主端口

部署状态下，实例 MUST NOT 发布任何宿主机端口。

#### Scenario: 从宿主机外访问实例端口

- **WHEN** 两个实例运行时检查各容器的端口映射
- **THEN** 实例容器没有任何端口映射；本部署发布的宿主端口只有平台的一个

### Requirement: 实例没有平台的权限

实例 MUST NOT 挂载 Docker socket，MUST NOT 持有平台的数据库文件、平台会话数据或管理密钥，MUST NOT 以特权模式运行。

#### Scenario: 实例内找不到 Docker socket

- **WHEN** 在实例里查找 Docker socket 并尝试调用 Docker 接口
- **THEN** socket 不存在，调用失败

#### Scenario: 实例内读不到平台数据

- **WHEN** 在实例里遍历文件系统和环境变量
- **THEN** 找不到平台的数据库文件、任何用户的密码哈希或平台会话值

#### Scenario: 容器不是特权容器

- **WHEN** 检查任一实例容器的配置
- **THEN** 不是特权模式，进程以非 root 用户运行

### Requirement: 实例不能借平台接口越权

从实例内部访问平台地址时，平台 MUST 按与外部请求相同的规则鉴权。

#### Scenario: 实例内无平台会话访问管理接口

- **WHEN** 在实例里不带平台会话请求平台的管理接口
- **THEN** 得到 401

#### Scenario: 员工平台会话访问管理接口

- **WHEN** 员工带着自己的平台会话请求管理接口
- **THEN** 得到 403

### Requirement: 受管覆盖层在实例内不可写

实例内的任何进程 MUST NOT 能修改或替换受管覆盖层文件，在 Yolo 档下也一样。

#### Scenario: Yolo 档下让 Agent 改覆盖层

- **WHEN** 员工在 Yolo 档下让 Agent 用 Shell 覆盖或删除受管覆盖层文件
- **THEN** 操作失败并报只读，文件内容不变

### Requirement: 已知边界写明

平台 MUST 在文档里列出本阶段不提供的隔离，至少包括：共用的模型密钥在实例内可读；实例可以访问宿主机所在内网的其他地址。

#### Scenario: 文档与实际一致

- **WHEN** 阅读部署文档的隔离一节并对照隔离测试
- **THEN** 测试断言的每条边界文档里都有，文档里列为“不提供”的每一项测试都没有断言它成立

### Requirement: 实例子网按配置池分配

平台 MUST 从配置的IPv4地址池按/28选择不与Docker已有网络子网重叠的地址段；已用地址以Docker当前网络为准，不存入数据库。

#### Scenario: 连续分配与释放复用

- **WHEN** 每次按更新后的已用子网快照分配，随后释放其中一段
- **THEN** 已分配的各段不重叠，释放的段可再次被选择；池满时明确报错而不重复分配

#### Scenario: 地址池不足以容纳同时运行上限

- **WHEN** 配置地址池的/28数量小于持久化的同时运行上限
- **THEN** 平台启动在监听前失败，错误指名PLATFORM_SUBNET_POOL；恰好足够则正常启动
