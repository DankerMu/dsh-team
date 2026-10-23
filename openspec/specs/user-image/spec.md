# user-image Specification

## Purpose

用户镜像是每个实例的运行环境：钉定版本的 DSH、Agent 生成文件所需的工具、预置的 DSH 配置目录，以及让 DSH 的 shell 沙箱可用的最小容器安全设置。

## Requirements

### Requirement: 钉定的 DSH 发行版

用户镜像 MUST 安装需求基线第 4 节钉定的 DSH 发行版；构建时解析到的版本与钉定值不一致时构建 MUST 失败。

#### Scenario: 版本一致

- **WHEN** 在构建出的镜像里查询 DSH 版本
- **THEN** 输出为钉定的版本

### Requirement: 镜像能启动 DSH Web

用镜像按规定的启动命令和一份受管覆盖层启动容器后，DSH Web MUST 在容器的 3080 端口监听，并在 stdout 打印启动令牌。

#### Scenario: 启动并取得令牌

- **WHEN** 用镜像和一份合法的受管覆盖层启动容器
- **THEN** 60 秒内容器日志里出现带启动令牌的地址，3080 端口可连接

#### Scenario: 无凭据访问被拒绝

- **WHEN** 不带 DSH cookie 请求该容器的首页
- **THEN** 得到 401

#### Scenario: 真实进程与交付安全设置的启动验证

- **WHEN** task7.4测试以交付的seccomp文件、只读最小覆盖层和两个独立命名卷启动实际DSH Web
- **THEN** 从启动开始同一个60秒期限内观察到真实令牌行，并从宿主经仅loopback发布的3080映射请求首页得到401
- **AND** 实际DSH进程为非root且含`DSH_TELEMETRY_DISABLED=1`，状态和工作目录分别挂载不同的可写卷
- **AND** 测试不输出或保存令牌及原始日志，成功或失败后只清理本次拥有的资源

### Requirement: 非 root 运行，状态和工作目录分开

容器内的 DSH 进程 MUST 以非 root 用户运行；DSH 状态目录和工作目录 MUST 是两个不同的挂载点。

#### Scenario: 进程用户

- **WHEN** 查看运行中容器的 DSH 进程
- **THEN** 进程的用户不是 root

### Requirement: 预置配置目录并保留初始副本

镜像 MUST 预置 DSH 的配置目录，使新用户的状态卷第一次挂载时自动带上；镜像 MUST 另存一份只读的初始副本，供重置实例配置使用。

#### Scenario: 新卷带上预置内容

- **WHEN** 用一个空的状态卷第一次启动容器
- **THEN** 卷里出现预置的配置目录，办公 Agent 的预设在界面里可选

#### Scenario: 初始副本不随用户改动变化

- **WHEN** 用户改动了自己状态卷里的配置目录
- **THEN** 镜像里的初始副本内容不变

#### Scenario: 首次卷填充与种子目录权限

- **WHEN** task7.3镜像以默认uid1001使用新的Docker命名状态卷，尚未运行会改写配置的DSH服务
- **THEN** 卷内profiles与`/opt/dsh-team/profile-seed/`的递归相对路径及文件字节一致，并包含实际Web profile和四个canonical中文插件交付文件，而不是两个空目录
- **AND** 用户能修改卷内配置，不能写入或替换种子文件；再次使用同一卷保留用户改动，种子仍不变
- **AND** 办公Agent预设和界面可选性由后续第17组交付，task7.3不以占位预设冒充

### Requirement: shell 沙箱可用的最小容器安全设置

仓库 MUST 提供一份容器安全设置（seccomp 配置和所需的其他选项），使 DSH 自带的 `bash` 工具在“工作区内修改”模式下可用。该设置 MUST 是经探测得到的最小组合，MUST NOT 使用特权模式。

#### Scenario: 工作区可写、状态目录不可写

- **WHEN** 用这份设置启动容器，在“工作区内修改”模式下让 DSH 的 `bash` 工具向工作目录和 DSH 状态目录各写一个文件
- **THEN** 工作目录的写入成功，状态目录的写入被拒绝

#### Scenario: 少一项就不可用

- **WHEN** 去掉这份设置里的任意一项放宽后重复上述操作
- **THEN** `bash` 工具报告沙箱不可用或写入失败

### Requirement: 可重复执行的探测脚本

仓库 MUST 提供一个探测脚本，在一台装有 Docker 的 Linux 主机上自动构建镜像、逐级尝试容器安全设置并输出最小可用组合。脚本 MUST 只创建带 `dsh-team` 前缀的镜像和容器，并在结束时删除它们。

#### Scenario: 在 amd64 主机上执行

- **WHEN** 在 amd64 的 Linux 主机上执行探测脚本
- **THEN** 脚本以零状态退出，输出每一级设置的结果和最终的最小可用组合，主机上不留下它创建的容器和镜像

#### Scenario: 没有可用组合时明确失败

- **WHEN** 在一台任何一级设置下沙箱都不可用的主机上执行
- **THEN** 脚本以非零状态退出，并列出每一级的失败原因

### Requirement: Agent 生成 DOCX 所需的运行环境

镜像 MUST 带有 Python 和生成 DOCX 所需的库，使办公 Agent 不联网也能生成可打开的 DOCX。

#### Scenario: 断网生成 DOCX

- **WHEN** 在实际网络模式为`none`的非root容器里运行一段用预装Python3和python-docx生成DOCX的脚本
- **THEN** 生成的文件能被`docx.Document`重新打开，中文段落和表格单元格内容与写入值完全一致

### Requirement: 关闭遥测

容器内的 DSH MUST 以关闭遥测的方式运行。

#### Scenario: 遥测开关

- **WHEN** 查看运行中 DSH 进程的环境
- **THEN** 关闭遥测的变量已设置

### Requirement: Docker 测试入口与可信 CI 证据

仓库 MUST 提供 `pnpm test:docker`，在 giap-vps 用真实 Docker 构建用户镜像并验证精确发行版；普通本地检查 MUST NOT 启动 Docker。测试 MUST 只清理本次运行创建的 `dsh-team-test-*` 资源，成功或失败均不留下这些资源。共享 VPS MUST NOT 向任意公开 PR 提供自动执行权。

#### Scenario: 精确版本与失败清理

- **WHEN** 可信会话在钉定的用户目录工具链下执行 Docker 测试
- **THEN** 镜像内版本必须精确匹配基线，退出后本次资源为空
- **AND** 人为版本断言失败时命令非零，但仍清理本次资源且保留其他运行的资源

#### Scenario: CI 绑定审查后的提交

- **WHEN** CI 判断 Docker 验证是否通过
- **THEN** 必须取得目标 PR head SHA 上仓库所有者发布的最新成功 `dsh-team/docker` 状态；缺失、失败、非可信发布者或其他 SHA 的结果均不能放行
- **AND** 主分支 squash 结果仅在关联已合并 PR 的 head 树与当前提交树完全相同时复用该 head 证据，并明确标记为树等价复用

### Requirement: 用户镜像使用官方 Debian 源并保留信任与运行时能力

用户镜像构建 MUST 保留已固定基础镜像原有的 Debian bookworm、bookworm-updates 官方普通源和官方安全更新源，不再强制重写为第三方镜像源。构建 MUST 保留 Debian 签名和有效期校验、原有 archive keyring、发行版和组件、包列表、当前基础镜像引用、DSH 版本及现有构建期限；MUST NOT 向运行时注入代理或复制源切换辅助程序。全部构建入口 MUST 使用相同官方源策略，保留范围限定的插件构建上下文，不得扩大为仓库根上下文或引入凭据。

#### Scenario: 全部构建入口使用一致策略

- **WHEN** 可信 Docker 测试、交付构建或现有探针构建用户镜像
- **THEN** 普通源、官方安全源和信任配置保持基础镜像原状，不再要求额外源切换上下文，原有精确版本、离线 DOCX、profile/seed、非 root 启动和运行时隔离验收继续成立

#### Scenario: 官方依赖获取失败

- **WHEN** 官方仓库不可达、签名或有效期校验失败，导致依赖安装不能完成
- **THEN** 原构建失败而不静默改用其他源、不关闭校验、不扩大期限，也不把局部成功报告为完整镜像验收通过

### Requirement: 用户镜像基础层身份固定且经审查更新

生产用户镜像 MUST 使用可读的精确 Node24补丁版本/Bookworm-slim标签与不可变基础镜像摘要；摘要 MUST 支持现有Linux amd64构建目标。基础层更新 MUST 通过显式审查，核对官方tag/index/platform/config身份并重新执行精确提交的原始完整Docker验收；MUST NOT 仅随major标签移动或以较窄smoke替代完整验收。仅固定基础身份不得声称动态apt/npm依赖也已完全可复现；其他镜像和历史phase0证据不随本要求自动迁移。

#### Scenario: 上游可变标签随后变化

- **WHEN** 上游修改原有major或patch标签指向，但仓库中的已审查摘要未改变
- **THEN** 用户镜像继续选择同一不可变基础身份，不静默改用标签的新目标

#### Scenario: 经审查更新基础层

- **WHEN** 维护者提交新的精确版本及摘要
- **THEN** 官方元数据和内容摘要核验支持目标架构，实际构建出的镜像证明Node24/Bookworm及原非root/DSH能力，原始完整Docker验收和独立清理通过后才交付
- **AND** DSH/pnpm pin、其他Dockerfile行为、其他镜像及所有既有gate保持不变
