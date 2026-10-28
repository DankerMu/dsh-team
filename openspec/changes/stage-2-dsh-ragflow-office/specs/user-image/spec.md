## ADDED Requirements

### Requirement: 镜像插件以 engines.dsh 声明兼容性

镜像交付的每个仓库插件和 bundle（中文界面、权限档、办公 Agent、平台入口、知识库、Office 提示）MUST 用 `engines.dsh` 声明与镜像内 DSH 版本兼容，MUST NOT 再用精确钉定 DSH 的 peer 依赖。镜像内 DSH 版本不满足任一插件声明的范围时，构建 MUST 失败。

#### Scenario: 实例加载全部镜像插件

- **WHEN** 员工实例在 DSH 0.2.1-rc.2 上启动并在真实浏览器中打开工作台
- **THEN** 每个镜像插件都被加载，没有一个因兼容性不满足被 DSH 跳过

#### Scenario: 版本不兼容时构建失败

- **WHEN** 某个镜像插件声明的 `engines.dsh` 范围不包含镜像内的 DSH 版本
- **THEN** 用户镜像构建以非零状态失败，而不是交付一个运行时会被跳过的插件

### Requirement: 侧栏插件与 Office 扩展名补丁

用户镜像 MUST 预装 `dsh-better-sidebar` 0.28.0，并在构建时打补丁：只从其宿主自有扩展名表中去掉 docx、xlsx、pptx，使这三类文件交给 ONLYOFFICE 插件打开，其余行为不变。补丁 MUST 在以下任一情况下让构建失败且不写文件：

- 该包版本不是 0.28.0；
- 全局模块中该包不是恰好一份；
- 任一被补文件的输入 SHA-256 不是评审过的值；
- 补丁结果的 SHA-256 不是评审过的值。

补好的文件 MUST 归 root 所有，普通用户不可写；补丁脚本 MUST NOT 留在镜像文件系统中。

#### Scenario: Office 文件交给 ONLYOFFICE

- **WHEN** 本次启动 Office 可用，员工在文件区打开一个 docx 文件
- **THEN** 文件由 ONLYOFFICE 插件打开，而不是侧栏自带的预览

#### Scenario: 镜像中的文件是补过的

- **WHEN** 检查构建出的用户镜像
- **THEN** 被补文件的 SHA-256 等于评审过的补丁后值，文件归 root 所有、uid1001 不可写，镜像中没有补丁脚本

#### Scenario: 版本或内容漂移时构建失败

- **WHEN** 补丁脚本遇到不同的包版本、零份或多份已安装副本，或不同的输入哈希
- **THEN** 脚本以非零状态退出，目标文件逐字节不变

### Requirement: ONLYOFFICE 插件与每实例文件令牌密钥补丁

用户镜像 MUST 预装 `dsh-sidebar-onlyoffice` 0.2.0，并在构建时打补丁：签发和校验文件令牌所用的密钥改为读取每个实例启动时注入的环境变量，替换源码中的公开常量；文档 key 改为用同一密钥对原 key 输入做 HMAC 得到，回调和编辑器打开只接受本实例密钥派生的 key。该环境变量缺失或为空时，签发和校验文件令牌 MUST 都拒绝。补丁的版本、副本数、输入和输出 SHA-256 校验以及文件属主要求与“侧栏插件与 Office 扩展名补丁”相同。

#### Scenario: 不同实例的令牌互不通用

- **WHEN** 两个以不同文件令牌密钥启动的实例各自签发一个文件令牌，再拿实例甲的令牌请求实例乙的文件接口
- **THEN** 实例乙拒绝该令牌

#### Scenario: 文档 key 依赖实例密钥

- **WHEN** 两个以不同文件令牌密钥启动的实例为同一 host 和路径的文件生成文档 key，再拿按原公开算法算出的 key 回调任一实例
- **THEN** 两个 key 不同，按原算法算出的 key 被两个实例拒绝

#### Scenario: 缺少密钥时拒绝

- **WHEN** 实例启动时没有注入文件令牌密钥，或注入的是空值
- **THEN** 插件不签发文件令牌，任何文件令牌在校验时都被拒绝，而不是退回到公开常量

#### Scenario: 公开常量签的令牌被拒绝

- **WHEN** 用源码中原有的公开常量签发一个令牌，请求任一实例的文件接口
- **THEN** 请求被拒绝

#### Scenario: 补丁漂移时构建失败

- **WHEN** 补丁脚本遇到不同的包版本、零份或多份已安装副本，或不同的输入哈希
- **THEN** 脚本以非零状态退出，目标文件逐字节不变

### Requirement: 旧格式只读预览所需的运行环境

用户镜像 MUST 带有 LibreOffice，使 DSH 自带的文档预览能在实例内、不联网地把 DOC、XLS、PPT，以及 Document Server 不可用时的 DOCX、XLSX、PPTX 转成 PDF 只读显示。

#### Scenario: 断网转换旧格式

- **WHEN** 在实际网络模式为 `none` 的非 root 容器里把一个 DOC 文件转换为 PDF
- **THEN** 转换成功，得到的 PDF 能被打开且包含原文中文内容

### Requirement: 知识库插件随镜像交付

用户镜像 MUST 把仓库插件 `knowledge-base` 以 root 所有、只读方式放在 `/opt/dsh-team/knowledge-base/`；所有构建用户镜像的入口 MUST 提供 `knowledge-base` 命名构建上下文。

#### Scenario: 插件文件只读

- **WHEN** 检查构建出的用户镜像
- **THEN** `/opt/dsh-team/knowledge-base/` 下文件归 root 所有、普通用户不可写，其兼容性声明满足镜像内的 DSH 版本

### Requirement: Office 提示插件随镜像交付

用户镜像 MUST 把仓库插件 `office-hints` 以 root 所有、只读方式放在 `/opt/dsh-team/office-hints/`；所有构建用户镜像的入口 MUST 提供 `office-hints` 命名构建上下文。它是受管必启项，只在 ONLYOFFICE 生效时显示人机同写、无 Session 和满员三条提示，不修改任何第三方包。

#### Scenario: 插件文件只读且不改第三方包

- **WHEN** 检查构建出的用户镜像
- **THEN** `/opt/dsh-team/office-hints/` 下文件归 root 所有、普通用户不可写，其兼容性声明满足镜像内的 DSH 版本；ONLYOFFICE 包的文件只有文件令牌补丁的改动

### Requirement: 插件目录文件随镜像交付

用户镜像 MUST 带有仓库中的预装插件目录文件，内容与平台镜像中的同一文件逐字节相同。预装项是镜像构建在 DSH 发行包之外额外加入的仓库插件、第三方全局包和办公 Agent bundle；DSH 发行包自带的 bundle 不是预装项。目录 MUST 列出镜像的每个预装项，每项包括标识、包名、中文名、类别（受管必启项或可管理项）和镜像默认的启用状态。目录中的每一项 MUST 确实预装在镜像中，镜像中的每个预装项也 MUST 出现在目录中，否则构建失败。

#### Scenario: 目录与镜像内容一致

- **WHEN** 检查构建出的用户镜像
- **THEN** 目录文件与仓库中的文件逐字节相同，目录中的每一项都能在镜像中找到对应的已安装包

#### Scenario: 目录与镜像不一致时构建失败

- **WHEN** 目录中有一项没有预装，或镜像中有一个预装项不在目录中
- **THEN** 用户镜像构建以非零状态失败，并列出不一致的条目

#### Scenario: DSH 发行包自带的 bundle 不计入

- **WHEN** 构建时对比目录和镜像实际内容
- **THEN** DSH 发行包自带的 bundle 不要求出现在目录中，也不会导致构建失败

### Requirement: 预装项在插件页都有开关

镜像的配置目录初始副本 MUST 把目录中的每个预装插件和 bundle 登记为 DSH 视为已安装的形式，启用状态等于目录中的镜像默认值，使员工插件页为每一项显示开关卡片。

#### Scenario: 新员工的插件页

- **WHEN** 新员工第一次启动实例并在真实 DSH 中打开侧栏插件页
- **THEN** 目录中的每个预装插件和 bundle（包括办公 Agent）都有一张开关卡片，初始状态等于镜像默认值；浏览器没有意外的控制台错误

#### Scenario: 开关状态持久

- **WHEN** 员工关掉一个员工自选的预装插件，然后重新加载页面并重启实例
- **THEN** 该插件仍为关闭

### Requirement: 镜像验收在 DSH 0.2.1-rc.2 上保持

DSH 升级到 0.2.1-rc.2 后，本能力既有的镜像验收 MUST 保持不变，包括：精确版本、启动与令牌、非 root 和分离挂载、配置目录初始副本、shell 沙箱安全设置、离线 DOCX、关闭遥测、官方源策略、基础层身份和平台入口插件。

#### Scenario: 升级后全量重跑

- **WHEN** 对 DSH 升级的精确提交执行完整的 `pnpm test:docker`
- **THEN** 本能力的既有验收全部通过，没有被跳过或放宽的用例

## MODIFIED Requirements

### Requirement: 钉定的 DSH 发行版

用户镜像 MUST 安装需求基线第 4 节钉定的 DSH 发行版（0.2.1-rc.2），以及同节钉定的 `dsh-better-sidebar`（0.28.0）和 `dsh-sidebar-onlyoffice`（0.2.0）；构建时解析到的任一版本与钉定值不一致时构建 MUST 失败。

#### Scenario: 版本一致

- **WHEN** 在构建出的镜像里查询 DSH 版本
- **THEN** 输出为钉定的版本 0.2.1-rc.2

#### Scenario: 侧栏插件版本一致

- **WHEN** 检查构建出的镜像中全局安装的 `dsh-better-sidebar` 和 `dsh-sidebar-onlyoffice`
- **THEN** 版本分别为 0.28.0 和 0.2.0；任一版本不符时构建失败

### Requirement: 镜像能启动 DSH Web

用镜像按规定的启动命令和一份受管覆盖层启动容器后，DSH Web MUST 在覆盖层指定的非通配地址的 3080 端口监听，并在 stdout 打印带该地址的启动令牌行。

#### Scenario: 启动并取得令牌

- **WHEN** 用镜像和一份监听地址为容器固定地址的合法受管覆盖层启动容器
- **THEN** 60 秒内容器日志里出现带启动令牌、且地址为该固定地址的启动行，该地址的 3080 端口可连接

#### Scenario: 通配地址被拒绝

- **WHEN** 覆盖层的监听地址是 `0.0.0.0`
- **THEN** DSH 拒绝启动 Web，不出现启动令牌行

#### Scenario: 无凭据访问被拒绝

- **WHEN** 不带 DSH cookie 请求该容器的首页
- **THEN** 得到 401

#### Scenario: 真实进程与交付安全设置的启动验证

- **WHEN** task7.4测试以交付的seccomp文件、监听地址为容器固定地址的只读最小覆盖层和两个独立命名卷启动实际DSH Web
- **THEN** 从启动开始同一个60秒期限内观察到真实令牌行，并从宿主经仅loopback发布的3080映射请求首页得到401
- **AND** 实际DSH进程为非root且含`DSH_TELEMETRY_DISABLED=1`，状态和工作目录分别挂载不同的可写卷
- **AND** 测试不输出或保存令牌及原始日志，成功或失败后只清理本次拥有的资源

### Requirement: 平台入口插件随镜像交付

用户镜像 MUST 把仓库插件 `platform-nav` 以 root 所有、只读方式放在 `/opt/dsh-team/platform-nav/`，其 `engines.dsh` 声明的范围 MUST 包含镜像内安装的 DSH 版本，否则构建失败；所有构建用户镜像的入口 MUST 提供 `platform-nav` 命名构建上下文。

#### Scenario: 插件文件只读且版本匹配

- **WHEN** 检查构建出的用户镜像
- **THEN** `/opt/dsh-team/platform-nav/` 下文件归 root 所有、普通用户不可写，`engines.dsh` 范围包含已安装 DSH 版本；不包含时镜像构建失败

## REMOVED Requirements

### Requirement: 插件页没有安装和卸载入口

**Reason**: 项目方 2026-10-28 决定（D9、F46 修订）撤回 #375，DSH 自带的添加、更新、卸载入口全部保留，同一套交付支持联网部署和内网部署；该补丁针对 0.2.0-rc.2 的文件，在 DSH 0.2.1-rc.2 下也已失效。

**Migration**: 删除插件页构建期补丁脚本及其 Dockerfile 步骤、测试和文档。员工插件页恢复 DSH 原生的添加、更新、卸载和插件市场入口；安装源和仓库探测改由管理员配置（见 managed-config“插件安装入口保留且安装源由管理员配置”），每个预装项的开关见“预装项在插件页都有开关”。
