# deployment Specification

## Purpose

把平台以容器方式部署到一台装有 Docker 的 Linux 主机上。本阶段只交付能起全套的骨架，不含离线打包、升级和备份。

## Requirements

### Requirement: 一条命令起全套

仓库 MUST 提供平台镜像的构建定义和一份 compose 文件；在构建好镜像的主机上，一条命令 MUST 能启动平台，随后员工可以注册、登录并进入自己的实例。

#### Scenario: 全新主机上启动

- **WHEN** 在一台只装了 Docker 的 Linux 主机上按文档构建两个镜像、填写配置、执行启动命令，再执行创建管理员的命令
- **THEN** 平台的健康检查返回正常，管理员能登录后台，新员工能注册并进入自己的实例完成一次对话

#### Scenario: 平台镜像可独立运行管理命令

- **WHEN** 在 Linux amd64 构建平台镜像且不挂载源码目录，执行镜像内管理员帮助命令
- **THEN** 非 root 进程列出 `admin create`；镜像自带可运行的生产依赖、可用数据库迁移、前端静态产物和默认路径上的 seccomp 配置
- **AND** 默认数据目录可写，应用代码保持不可由运行用户改写；构建不带入本地密钥或参考资源

### Requirement: 平台数据持久

平台的数据库 MUST 保存在容器之外的持久位置，平台容器重建后账号、设置和审计 MUST 仍在。

#### Scenario: 重建平台容器

- **WHEN** 平台容器被删除并重新创建
- **THEN** 已有账号能登录，模型配置和审计记录不变，已有实例照常可用

### Requirement: 配置项明确且缺失时启动失败

部署所需的配置项 MUST 全部列在示例文件里。必填项缺失或取值不合法时，平台 MUST 在启动时报错退出，并指出是哪一项。

#### Scenario: 缺少对外地址

- **WHEN** 未设置平台对外地址就启动平台
- **THEN** 平台退出，错误信息指出缺少该配置项

#### Scenario: 示例文件与实际一致

- **WHEN** 对照平台读取的 `PLATFORM_*`、Compose 消费的 `DEPLOY_*` 与单一示例文件中各自对应的变量名
- **THEN** 每组变量名完全对应，示例没有未被消费的配置项、读取方没有未列出的配置项，且示例文件没有任何真实密钥

### Requirement: 只有平台对外

本部署在宿主机上 MUST 只发布平台的一个端口，实例容器 MUST NOT 有任何端口映射；Docker socket MUST 只挂给平台容器。

#### Scenario: 检查端口和挂载

- **WHEN** 全套启动且有两个实例运行时检查各容器的端口映射和挂载
- **THEN** 本部署发布的宿主端口只有平台的一个；只有平台容器挂载了 Docker socket

### Requirement: 可在前置代理后使用 HTTPS

平台 MUST 只提供 HTTP；对外地址和“平台会话 cookie 仅在 HTTPS 下发送”MUST 是两个配置项，使平台放在终结 TLS 的反向代理之后不需要改代码。受信代理的地址 MUST 是第三个配置项，默认为空（见 `account-auth` 的“来源地址的确定”）。

#### Scenario: 配置为 HTTPS 对外地址

- **WHEN** 对外地址配置为 `https://` 开头并开启仅 HTTPS 发送，代理的地址填入受信代理，请求经这个终结 TLS 的代理到达平台
- **THEN** 登录、工作台和长连接都正常，平台会话 cookie 带 `Secure`

### Requirement: 部署文档

仓库 MUST 提供部署文档，包含前置条件、构建和启动步骤、创建管理员、配置模型，以及本阶段不提供的隔离和功能。

#### Scenario: 按文档完成部署

- **WHEN** 一个没有参与开发的人只按文档操作
- **THEN** 能完成上面“全新主机上启动”的全部步骤

### Requirement: Audit verification preserves graceful stop and bounded failure

The deployed audit verification sequence MUST allow an owned platform stop to complete during its requested30s graceful interval without the caller's ordinary15s observation deadline interrupting it. The platform stop caller MUST retain a finite deadline with completion margin. Other observations MUST retain their existing15s deadline. Success MUST still require exact ownership, inspected exit0 and ordered restart. Deadline failure MUST propagate through actual fixture drainage and canonical cleanup, never become acceptance success.

#### Scenario: Graceful completion after the ordinary observation deadline

- **WHEN** the exact owned platform completes its audit stop after15s and before30s
- **THEN** the caller permits completion, verifies exit0, restarts the captured platform and completes the real audit sequence

#### Scenario: Command does not complete within its envelope

- **WHEN** the external platform-stop command exceeds its finite caller deadline
- **THEN** the command fails after child closure, the audit scenario fails without attempting restart, and real fixture cleanup still retires its owned resources

### Requirement: Deployment verification preserves safe setup-boundary evidence

Deployment verification SHALL identify the entered setup operation and last completed boundary using bounded closed-set phase values. A setup failure SHALL retain rejection and a fixed reason category without serializing raw exceptions, command arguments or output, credentials, proxy values, environment values or private conversation content. An observed boundary SHALL NOT be described as the underlying cause when that cause is unknown.

#### Scenario: Setup fails before audit-stop admission

- **WHEN** preparation, image construction, platform admission, health, administrator initialization or account configuration fails before the audit-stop exercise
- **THEN** evidence distinguishes the failing setup boundary from the last completed boundary and from the unentered stop phase, while the invocation remains failed

#### Scenario: Failure carries secret-bearing arbitrary data

- **WHEN** a setup dependency rejects with credentials or private data in its message, nested cause, aggregate members or attached output fields
- **THEN** only allowlisted phase and reason facts are exposed, none of those data appear in diagnostics or the sanitized rejection, and the failure is not converted into success

#### Scenario: Setup succeeds

- **WHEN** all setup boundaries complete
- **THEN** evidence records completion and the original audit/privacy verification proceeds without a retry, changed deadline, changed ordering or substituted acceptance assertion

#### Scenario: Nested setup rejects after an inner boundary completed

- **WHEN** a child operation completes but its enclosing setup operation later rejects
- **THEN** the completed child is not misreported as the failure, the unfinished enclosing boundary is retained, and cleanup cannot overwrite the first failure

#### Scenario: Diagnostic evidence cannot be retained

- **WHEN** the diagnostic output or retention boundary fails while reporting setup failure
- **THEN** the original safe primary-failure facts remain available where possible, evidence loss is explicit, and neither setup nor cleanup is reported successful because observation failed

### Requirement: Setup diagnostics preserve independent cleanup and historical uncertainty

Setup observation SHALL preserve the first failing boundary separately from subsequent owned drainage or cleanup failures. It SHALL NOT expand cleanup authority or report successful retirement from a failed or unavailable observation. Historical failures without retained boundary facts SHALL remain explicitly unknown; later successful qualification SHALL NOT be represented as their root-cause repair.

#### Scenario: Primary failure and cleanup failure coexist

- **WHEN** setup fails and an independent owned cleanup operation also fails
- **THEN** the safe evidence preserves both failure classes without losing the first setup boundary or exposing either raw exception, and acceptance remains failed with cleanup unconfirmed

#### Scenario: Cleanup succeeds after setup failure

- **WHEN** the original setup fails but its exact-owned cleanup completes
- **THEN** evidence keeps the original failed verdict distinct from successful cleanup and does not authorize unrelated deletion

#### Scenario: A later full qualification succeeds

- **WHEN** original complete Docker discovery and standalone deployment qualification succeed on a new reviewed candidate
- **THEN** that candidate's results are recorded separately, while the earlier setup cause remains unknown unless a causally matched failing-before and passing-after observation establishes it

### Requirement: Controlled deployment failure regressions retire their own observer root

A deployment verification test whose scenario failure is a deliberately injected and asserted expectation SHALL remove the private observation root it owns after all of its assertions pass, using the observation it captured and the existing directory identity fence. Observation roots of genuine failures, failed regressions and outer custody-owned roots SHALL be retained as before. Removal SHALL NOT discover, prefix-match or globally clean `/tmp`, and a removal failure SHALL fail the test.

#### Scenario: Controlled failure regression passes

- **WHEN** a deployment regression injects its expected failure and all of its assertions pass
- **THEN** its captured, retired, identity-verified owned observer root is removed and no new `/tmp/dsh-team-observer-*` directory remains after the run

#### Scenario: Regression or retirement fails

- **WHEN** the regression's assertions fail, the observation was not retired, or the root identity changed
- **THEN** the root is retained and the test reports failure
