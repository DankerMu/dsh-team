## MODIFIED Requirements

### Requirement: 一条命令起全套

仓库 MUST 提供平台镜像的构建定义和一份 compose 文件；在构建好镜像的主机上，一条命令 MUST 能启动平台和自带的 Document Server，随后员工可以注册、登录并进入自己的实例。

#### Scenario: 全新主机上启动

- **WHEN** 在一台只装了 Docker 的 Linux 主机上按文档构建两个镜像、填写配置、执行启动命令，再执行创建管理员的命令
- **THEN** 平台的健康检查返回正常，管理员能登录后台，新员工能注册并进入自己的实例完成一次对话

#### Scenario: 平台镜像可独立运行管理命令

- **WHEN** 在 Linux amd64 构建平台镜像且不挂载源码目录，执行镜像内管理员帮助命令
- **THEN** 非 root 进程列出 `admin create`；镜像自带可运行的生产依赖、可用数据库迁移、前端静态产物和默认路径上的 seccomp 配置
- **AND** 默认数据目录可写，应用代码保持不可由运行用户改写；构建不带入本地密钥或参考资源

#### Scenario: 同一条命令起 Document Server

- **WHEN** 按文档执行启动命令
- **THEN** compose 同时启动版本为 9.4.0、开启 JWT、容器名固定的 Document Server；运营方字体目录以只读方式挂载进去

### Requirement: 配置项明确且缺失时启动失败

部署所需的配置项 MUST 全部列在示例文件里。必填项缺失或取值不合法时，平台 MUST 在启动时报错退出，并指出是哪一项。自带 Document Server 的地址和 JWT 密钥 MUST 来自同一份部署配置，compose 与平台共用，不得在两处分别填写。

#### Scenario: 缺少对外地址

- **WHEN** 未设置平台对外地址就启动平台
- **THEN** 平台退出，错误信息指出缺少该配置项

#### Scenario: 示例文件与实际一致

- **WHEN** 对照平台读取的 `PLATFORM_*`、Compose 消费的 `DEPLOY_*` 与单一示例文件中各自对应的变量名
- **THEN** 每组变量名完全对应，示例没有未被消费的配置项、读取方没有未列出的配置项，且示例文件没有任何真实密钥

#### Scenario: Document Server 配置单一来源

- **WHEN** 部署配置里填写了 Document Server 的 JWT 密钥并启动全套
- **THEN** Document Server 使用的 JWT 密钥与平台下发给实例的相同；缺失或为空时平台启动失败并指出该配置项，不回显取值

### Requirement: 只有平台对外

本部署在宿主机上 MUST 只发布平台的一个端口，实例容器和 Document Server MUST NOT 有任何端口映射；Docker socket MUST 只挂给平台容器。

#### Scenario: 检查端口和挂载

- **WHEN** 全套启动且有两个实例运行时检查各容器的端口映射和挂载
- **THEN** 本部署发布的宿主端口只有平台的一个；Document Server 没有端口映射；只有平台容器挂载了 Docker socket

### Requirement: 部署文档

仓库 MUST 提供部署文档，包含前置条件、构建和启动步骤、创建管理员、配置模型，以及本阶段不提供的隔离和功能。文档 MUST 另外说明 Document Server 的字体目录准备、地址与 JWT 配置、切换到外部 Document Server 时由运营方负责网络可达，以及 RAGFlow 连接在后台配置。

#### Scenario: 按文档完成部署

- **WHEN** 一个没有参与开发的人只按文档操作
- **THEN** 能完成上面“全新主机上启动”的全部步骤

#### Scenario: 按文档接入 Office 和知识库

- **WHEN** 运营方按文档准备字体目录、填写 Document Server 配置，并在后台填写 RAGFlow 地址和密钥
- **THEN** 员工能在实例内用 Office 编辑器打开文档，并能看到知识库列表
