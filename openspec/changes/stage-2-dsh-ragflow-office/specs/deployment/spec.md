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
- **THEN** compose 同时启动版本为 9.4.0、开启 JWT（密钥取自 `.env` 中必填的 `DOCUMENT_SERVER_JWT_SECRET`）、容器名固定为 `dsh-team-documentserver` 的 Document Server；运营方字体目录以只读方式挂载进去

### Requirement: 配置项明确且缺失时启动失败

部署所需的配置项 MUST 全部列在示例文件里。必填项缺失或取值不合法时，平台 MUST 在启动时报错退出，并指出是哪一项。

自带 Document Server 有两项输入：`DOCUMENT_SERVER_CONTAINER_NAME`（容器名）和 `DOCUMENT_SERVER_JWT_SECRET`（JWT 密钥），两项都以有效赋值列在示例文件里：容器名取 compose 字面量 `dsh-team-documentserver`，JWT 为空值，示例不放任何密钥或占位密钥。自带 Document Server 没有地址输入，地址由每个实例的固定布局决定。这两项由平台读取，JWT 同时被 compose 插值，是平台和 compose 共用的一类配置。

交付的 compose MUST 与 `PLATFORM_CONTAINER_NAME` 相同处理容器名：把 Document Server 的容器名固定写为字面量 `dsh-team-documentserver`，并以同一字面量作为 `DOCUMENT_SERVER_CONTAINER_NAME` 传给平台，不从 `.env` 插值。JWT MUST 只来自 `.env` 中的同一个 `DOCUMENT_SERVER_JWT_SECRET`，以 `${DOCUMENT_SERVER_JWT_SECRET:?…}` 必填插值同时传给 Document Server 和平台，不得在两处分别填写。因此 compose 部署 MUST 设置该 JWT：未设置或为空时，compose 在创建任何容器前失败并指出该变量。

平台自身对这两项采用三态校验，不为容器名提供默认值：两项都不存在时平台照常启动，自带 Document Server 视为未配置、Office 不可用；任一项显式为空，或只存在其中一项时，平台 MUST 在监听前失败并指出该配置项，不回显取值。「两项都不填则 Office 不可用」只适用于不经交付 compose 的开发、测试入口。照原样复制示例文件的本地运行带有容器名和空 JWT，属于显式为空，平台 MUST 在监听前失败并指出 `DOCUMENT_SERVER_JWT_SECRET`；本地运行要么删去这两行，要么两项都填非空值。

#### Scenario: 缺少对外地址

- **WHEN** 未设置平台对外地址就启动平台
- **THEN** 平台退出，错误信息指出缺少该配置项

#### Scenario: 示例文件与实际一致

- **WHEN** 对照平台读取的 `PLATFORM_*` 和 `DOCUMENT_SERVER_*`、Compose 插值的 `DEPLOY_*` 和 `DOCUMENT_SERVER_JWT_SECRET` 与单一示例文件中各自对应的变量名
- **THEN** 每组变量名完全对应，示例没有未被消费的配置项、读取方没有未列出的配置项，且示例文件没有任何真实密钥；`DOCUMENT_SERVER_JWT_SECRET` 在示例中为空值

#### Scenario: Document Server 配置单一来源

- **WHEN** `.env` 里填写了 `DOCUMENT_SERVER_JWT_SECRET` 并用交付的 compose 启动全套
- **THEN** Document Server 使用的 JWT 密钥与平台下发给实例的相同，平台收到的容器名是 compose 中的字面量 `dsh-team-documentserver`，平台接入的正是该容器

#### Scenario: compose 部署未设置 JWT

- **WHEN** `.env` 中没有 `DOCUMENT_SERVER_JWT_SECRET` 或其值为空，用交付的 compose 执行启动命令
- **THEN** compose 在创建任何容器前失败，错误信息指出该变量；平台和 Document Server 都没有启动

#### Scenario: Document Server 配置只给一项

- **WHEN** 不经交付的 compose 启动平台，环境中只存在 Document Server 的容器名或只存在 JWT 密钥，另一项不存在
- **THEN** 平台在监听前退出，错误信息指出缺失的配置项，不回显取值

#### Scenario: Document Server 配置显式为空

- **WHEN** 启动平台时任一项存在且为空字符串，无论另一项是否存在或是否为空
- **THEN** 平台在监听前退出，错误信息指出为空的配置项，不回显取值，不当作未配置

#### Scenario: 开发或测试入口不配置 Document Server

- **WHEN** 不经交付的 compose，两项都不存在就启动平台，例如自己构造环境的测试入口，或删去了这两行的本地 `.env`
- **THEN** 平台照常启动和服务，实例照常就绪，Office 不可用

#### Scenario: 照原样复制示例文件的本地运行

- **WHEN** 把示例文件原样复制为 `.env`，不经交付的 compose 用读取 `.env` 的本地入口启动平台
- **THEN** 平台在监听前退出，错误信息指出 `DOCUMENT_SERVER_JWT_SECRET`，不回显取值，不当作未配置
- **AND** 从该 `.env` 删去两项后平台照常启动、Office 不可用；两项都填非空值时平台照常启动

### Requirement: 只有平台对外

本部署在宿主机上 MUST 只发布平台的一个端口，实例容器和 Document Server MUST NOT 有任何端口映射；Docker socket MUST 只挂给平台容器。

#### Scenario: 检查端口和挂载

- **WHEN** 全套启动且有两个实例运行时检查各容器的端口映射和挂载
- **THEN** 本部署发布的宿主端口只有平台的一个；Document Server 没有端口映射；只有平台容器挂载了 Docker socket

### Requirement: 部署文档

仓库 MUST 提供部署文档，包含前置条件、构建和启动步骤、创建管理员、配置模型，以及本阶段不提供的隔离和功能。文档 MUST 另外说明 Document Server 的字体目录准备、compose 固定容器名且部署必须设置 JWT（阶段 1 的 compose 部署升级时要在 `.env` 新增 `DOCUMENT_SERVER_JWT_SECRET`，否则启动前失败）、不经 compose 的开发测试入口两项都不填时 Office 不可用、照原样复制示例的本地运行会因空 JWT 启动失败（须删去两行或两项都填）、Document Server 重建后已运行实例要重启才恢复 Office、切换到外部 Document Server 时由运营方负责网络可达，以及 RAGFlow 连接在后台配置。

#### Scenario: 按文档完成部署

- **WHEN** 一个没有参与开发的人只按文档操作
- **THEN** 能完成上面“全新主机上启动”的全部步骤

#### Scenario: 按文档接入 Office 和知识库

- **WHEN** 运营方按文档准备字体目录、填写 Document Server 配置，并在后台填写 RAGFlow 地址和密钥
- **THEN** 员工能在实例内用 Office 编辑器打开文档，并能看到知识库列表
