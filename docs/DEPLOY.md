# 阶段 1：单机 Docker 部署

本指南用于一台 Linux 主机上的**全新安装**。平台服务提供 HTTP，员工各有独立 DSH 实例。不是离线包、升级、备份恢复或生产证书管理手册；不要把测试验收等同于生产容量认证。

配置清单唯一来源是 [`.env.example`](../.env.example)，实际部署定义是 [`deploy/compose.yml`](../deploy/compose.yml)。不要另建示例配置，也不要修改 DSH 源码或版本。

## 1. 前置条件

- Linux amd64；已验证环境为 Ubuntu 24.04、Docker Engine 29.1.3。使用本机默认 Docker daemon、普通 UID 映射；不支持本手册之外的 rootless/userns、远程 Docker context 或 Docker Desktop。
- Docker Compose **2.33.1 或更新版本**，Engine 支持 endpoint gateway priority。构建器支持 `--build-context`。保留 Compose 主网络 `gw_priority: 1`，不能用连接顺序或重试替代。
- 操作用户有 Docker 权限；平台镜像用户是 uid1000，员工镜像用户是 uid1001。Docker 权限近似宿主 root 权限，不能授予员工。以下数据目录命令按操作用户 uid1000 编写；其他 UID 应先由主机管理员建立归 uid1000 所有的目录，不能改为 root 运行平台或放宽 socket 到全员可写。
- 构建和沙箱探针需要访问镜像仓库、npm、Debian 软件源及固定 seccomp 来源。本阶段不提供断网安装材料。
- 主机准备 Git、Node **24.13.1**、pnpm **10.34.6**、Bash、curl、GNU `timeout`。完整仓库检查另需 hurl、shellcheck、gitleaks；Compose 自动验收另需 Python3、util-linux `flock` 和 openssl。工具版本以 [`.tool-versions`](../.tool-versions) 为准。
- 选定实际对外地址、可用平台端口及不与宿主/LAN/Docker 网络重叠的 IPv4 池。默认 `172.30.0.0/16` 按 `/28` 分配；几何容量必须容纳持久化的同时运行上限，不能仅因示例有默认值就认为不冲突。
- 模型网关由管理员另行准备。密钥只通过平台管理接口输入，不写入源码、命令行参数、聊天记录或 shell 历史。

从固定、经过审查的提交开始，所有下述命令均在仓库根目录执行：

```sh
git clone https://github.com/DankerMu/dsh-team.git dsh-team
cd dsh-team
git checkout --detach <已审查的完整提交SHA>
pnpm install --frozen-lockfile
docker version
docker compose version
```

不要读取或输出已有 `.env`。若目标主机已有 `dsh-team-platform`、本指南的镜像标签或同名数据目录，停止全新安装流程；本指南没有接管或覆盖既有部署的权限。

## 2. 构建两个镜像

先记录本次安装标识；保留到验收结束，用于核对自有资源，而不是按前缀删除：

```sh
DEPLOY_RUN="$(node -p 'crypto.randomUUID()')"
DEPLOY_PROJECT="dsh-team-${DEPLOY_RUN}"
DEPLOY_ROOT="$HOME/.local/share/dsh-team/${DEPLOY_RUN}"
export DEPLOY_RUN DEPLOY_PROJECT DEPLOY_ROOT

docker build --label "dsh-team.deploy-run=$DEPLOY_RUN" \
  -t dsh-team-user:local -f images/dsh-user/Dockerfile \
  --build-context zh-locale=plugins/zh-locale \
  --build-context permission-tiers=plugins/permission-tiers \
  --build-context office-agents=plugins/office-agents \
  --build-context platform-nav=plugins/platform-nav images/dsh-user

docker build --label "dsh-team.deploy-run=$DEPLOY_RUN" \
  -t dsh-team-platform:local -f platform/Dockerfile .

docker image inspect --format '{{.Id}}' dsh-team-user:local dsh-team-platform:local
```

记录两个不可变 image ID。用户镜像内 DSH 固定为 `0.2.1-rc.2`，包含中文界面、权限插件、办公预设、侧栏平台入口插件和 python-docx；四个插件以 `engines.dsh` 声明兼容范围，镜像内 DSH 不满足任一范围，或 `dsh --profile web --dump-default-config` 在注册办公 bundle 后报告 `dsh: skipping profile bundle` 时，构建以非零状态失败（该命令不启动 DSH、不接受 `--patch`，不经过启动时打印 `dsh: disabling profile plugin` 的逐行检查，构建期不会出现该前缀；插入行的兼容性由 `engines.dsh` 检查保证）；平台多阶段镜像含编译服务、CLI、前端、迁移和 native SQLite 依赖，不依赖宿主源码挂载。不要省略四个插件 named context。用户镜像和验证浏览器镜像均保留已固定基础镜像的 Debian 官方普通源及安全更新源，不再使用额外的源切换上下文；archive keyring、签名/有效期校验、包列表和构建期限保持不变，获取失败不得自动换源或关闭校验。

插件页保留 DSH 原生的添加、更新、卸载入口，开关和配置卡片照常；受管覆盖层不再去掉 Agent 的插件管理工具，但目前仍关闭插件页的公共仓库探测（`registryProbeEnabled: false`，第 11 组接入后台开关后改为管理员配置）。升级前员工自己安装的 bundle 仍然保留，可以关闭或卸载；管理员重置该员工的 DSH 设置可恢复镜像的 profile 初始副本。员工仍可在终端用 `dsh plugin add` 安装插件，按 D9/F46（2026-10-28 修订）这是允许的行为。

**升级说明（本手册其余部分仍只覆盖全新安装）。** 已有员工卷的主机换用 `0.2.1-rc.2` 用户镜像后，每个现有员工的状态卷仍保存阶段 1 的 profile：DSH 0.2.1 会跳过其中的 bundle，受管组合被拒绝，该员工的实例启动失败，直到管理员在实例页面为其执行「重置配置」。这是必须的运维步骤，需对每个现有员工执行；重置只恢复 DSH 设置，文件和对话保留，重置后实例保持停止，下次需显式启动。仍在运行的 `0.2.0` 实例继续运行，直到空闲回收或重启。

### 用户镜像基础层更新

生产用户镜像的基础身份以 [`images/dsh-user/Dockerfile`](../images/dsh-user/Dockerfile) 的 `FROM` 为唯一来源：精确 Node24补丁版本、Bookworm-slim标签和不可变多架构 index 摘要同时保留。部署验收仍只覆盖现有 Linux amd64；index 内包含其他架构不代表已验证这些架构。不要退回 major-only 标签，也不要把浏览器或平台镜像的基础引用自动套到用户镜像。

更新必须提交显式审查 PR：从 [Docker Official Image Node](https://hub.docker.com/_/node) 对应精确标签取得 index，核对官方 registry 的 index/platform manifest/config 内容摘要、Linux amd64成员和 `NODE_VERSION`；实际构建后观察 Node版本、Debian Bookworm、默认uid1001及精确DSH版本，并在受信 giap-vps 对最终审查提交运行原始完整 `pnpm test:docker`，保留独立资源清理和其他宿主工作负载未变的证据。不能用只读标签检查或较窄 smoke 替代完整验收。`images/dsh-user/` 每一行变更仍须人工白盒审查；回滚同样通过审查恢复先前引用。

此摘要只冻结基础层身份，不冻结后续动态 apt/npm 依赖解析，不能据此声称整个镜像逐字节可复现。保留现有 DSH/pnpm pin、Debian源及签名校验、其他构建指令和门禁；其他镜像及历史 `verify/phase0/` 不随本次固定自动修改。

## 3. 准备数据和唯一配置副本

```sh
install -d -m 700 "$DEPLOY_ROOT" "$DEPLOY_ROOT/data" "$DEPLOY_ROOT/managed"
cp .env.example .env
chmod 600 .env
stat -c %g /var/run/docker.sock
```

用编辑器填写新副本，不要 `cat .env` 或运行会打印完整展开配置的命令。Compose 显式映射变量，不会把整个宿主环境交给容器。

| 变量 | 本部署填写规则 |
|---|---|
| `PLATFORM_HOST` | `0.0.0.0`；示例的回环值不适用于容器对外入口 |
| `PLATFORM_PORT` | 可用端口，如 `8080`；Compose 的宿主/容器端口相同 |
| `PLATFORM_PUBLIC_URL` | 浏览器实际使用的完整 HTTP(S) origin，含非默认端口；不能使用容器内部地址冒充公网/内网入口 |
| `PLATFORM_DATA_DIR` | 上面创建的 `$DEPLOY_ROOT/data` 的**展开后绝对路径** |
| `PLATFORM_MANAGED_CONFIG_DIR` | `$DEPLOY_ROOT/managed` 的**展开后绝对路径** |
| `PLATFORM_DOCKER_SOCKET` | `/var/run/docker.sock` |
| `DEPLOY_DOCKER_GID` | 上一步 `stat` 返回的实际数字；只加补充组，不改变镜像用户 |
| `PLATFORM_USER_IMAGE` | `dsh-team-user:local` |
| `PLATFORM_SECCOMP_PROFILE` | 平台镜像内 `/app/images/seccomp/dsh-user.json` |
| `PLATFORM_SUBNET_POOL` | 经主机管理员检查无冲突的 canonical IPv4 网络 CIDR |
| `PLATFORM_UPSTREAM_MODE` / `PLATFORM_CONTAINER_NAME` | `network` / `dsh-team-platform`；Compose 固定这两个值 |
| `PLATFORM_COOKIE_SECURE` | HTTP 测试为 `false`；HTTPS 入口为 `true`，与对外 URL 独立配置 |
| `PLATFORM_TRUSTED_PROXIES` | 直连留空；前置代理时填写精确代理 IP，逗号分隔，不接受 CIDR/通配符 |
| `PLATFORM_LOG_LEVEL` | 正常运行 `info`；禁止为排障输出凭据或会话内容 |

两个目录在宿主与平台容器中必须是**同一绝对路径**，并且预先可由 uid1000 写入；Compose 不自动创建缺失的 bind 目录。不要把宿主路径 `/srv/...` 映射到不同的容器路径 `/data/...`。不要设置 `DMXAPI_KEY`、`CHROME_BIN` 或 CI channel/journal 作为平台部署输入。

## 4. 在目标主机运行真实沙箱探针

```sh
pnpm probe:sandbox
```

这是诊断梯子：实际调用固定发行版 DSH 的 bash 工具，依次尝试 Docker 默认限制、额外放宽 syscall 的探针策略、再加 `systempaths=unconfined`，输出首个可用组合并清理自己的测试资源。本次 giap-vps 演练首个可用组合是 `docker-default`；这不证明引擎内嵌策略与提交文件相同。

**交付策略不是梯子的放宽候选。** 员工实例显式使用仓库提交的、未增补 syscall 的钉定 Moby 默认策略，保留 Docker 的 MaskedPaths/ReadonlyPaths；禁止 `systempaths=unconfined`、额外capability、特权模式和unconfined seccomp。继续安装前，还必须按 [seccomp说明“用现有 driver 跑这份文件”](../images/seccomp/README.md#用现有-driver-跑这份文件) 的完整命令对 `images/seccomp/dsh-user.json` 单独验证，不能只凭梯子退出0批准目标机。

显式策略验证必须容器退出0，且唯一 `PROBE_RESULT` 中 `usable`、`wsOk`、`stateDenied` 为true，`statePresent` 为false（工作区写入/读回成功、状态目录写入拒绝）。若只有探针放宽级成功而显式交付策略不通过，停止部署并保留证据；不得把生产限制改成探针候选来“通过”。两种检查都不是手写bubblewrap的替代测试；清理失败也禁止继续。梯子会联网获取并校验固定seccomp来源，两种检查均不调用模型。

## 5. 启动、创建管理员、配置模型

```sh
docker compose --project-name "$DEPLOY_PROJECT" --project-directory . \
  --env-file .env -f deploy/compose.yml up -d
curl --fail --silent --show-error http://127.0.0.1:8080/healthz
```

将健康探测端口替换为实际 `PLATFORM_PORT`；期望 `{"status":"ok"}`。健康正常只证明平台存活，不证明模型和员工实例已经可用。记录固定平台容器的不可变 ID 以及 Compose project 标签。

邮箱用于注册、登录和管理员命令时，先去首尾空白并转小写，再限制为最多254个Unicode码点（不是UTF-8字节或UTF-16码元）。超界HTTP输入返回400，命令在读取密码和打开数据库前拒绝；不会截断邮箱或新增失败登录审计。

**已有数据的启动兼容性检查（#126）**：任何已有账号（含禁用账号）的存储邮箱超界，平台在Docker协调和监听前明确退出，提示 `Account email exceeds 254 Unicode code points; correct accounts offline before startup`。它不会自动改写、截断或禁用账号。处理前停止平台及其他数据库写入者，完成可恢复备份；由授权管理员离线检查并更正超界账号的 `users.email`，保留原 `id`、密码、角色、状态和其他关联记录。新邮箱必须去首尾空白、转小写、符合原邮箱结构规则且全局唯一；计数必须包含NUL后的字符，不能仅用SQLite的 `length(TEXT)` 判断。确认新身份归属后再启动；本修复不提供自动迁移或修复命令，也不是通用升级/恢复流程。

历史审计邮箱保持原文，不随账号更名重写，也不会单独阻止启动。可按事件/时间或不按邮箱浏览；HTTP邮箱筛选的原始值最多254个码点，随后规范化并精确匹配。超界筛选返回400，截断前缀不匹配旧身份；既有大记录不会被压缩或回收。

在**真实交互终端**创建管理员（将邮箱换成自己的）：

```sh
docker compose --project-name "$DEPLOY_PROJECT" --project-directory . \
  --env-file .env -f deploy/compose.yml exec platform \
  node platform/dist/cli.js admin create admin@example.test
```

不要加 `-T`，不要把密码放在参数或环境变量里；按两次隐藏提示输入密码。创建成功后：

1. 用对外地址访问 `/_platform/login`。所有账号（含管理员）登录后都进入 `/`；实例未运行时停在等待页：管理员在任一状态都可点「管理后台」进入 `/_platform/admin`，模型未配置时另可点「去配置模型」进入 `/_platform/admin/models`。管理员进入工作台会启动自己的实例，占用一个同时运行名额。
2. 填写真实模型服务 Base URL、密钥、模型名和默认模型，保存。密钥不回显；更新配置不热切换已运行实例，下次启动/管理员重启生效。
3. 用独立员工账号访问 `/_platform/register` 注册，再登录。进入等待页后应启动自己的实例并进入原生工作台。工作台左侧栏底部有平台入口：所有人可见「账号设置」（`/_platform/account`，改密码/退出登录），实例启动时账号为管理员才显示「管理后台」（`/_platform/admin`）；两者都是同页链接，侧栏收起时为带名称的图标。角色变化在该用户下次启动实例后生效，后台权限仍由服务端校验。
4. 检查原生页面及 WebSocket 连接；模型连通性另行用批准的真实任务验收。工作台页面资源按浏览器声明以 gzip 压缩传输（DSH 自带压缩，事件流不压缩），平台网关为文件名带内容哈希的 `/assets/` 静态资源加 `Cache-Control: private, max-age=31536000, immutable`；压缩设置写在受管覆盖层中，已运行实例在下次启动后生效。网关还给每个转发的工作台响应合并 `Vary: Cookie`，所以长期缓存只在同一次登录内复用；每次新登录后第一次打开工作台都要重新下载这些资源（经验收 SSH 隧道约 9.5 秒，内网直连明显更短）。仅保存模型配置和打开工作台不代表推理成功。模型页的「测试默认模型连接」只用上次保存的地址、密钥和默认模型，按 DSH 相同规则（地址后接 `/chat/completions`，平台不补 `/v1`）发一次 `max_tokens: 1` 的非流式请求，20 秒超时。「连接成功」只证明从平台容器（Compose `default` 网络、不读 `HTTP(S)_PROXY`；TLS 信任 Node 内置 CA 库，不读镜像系统证书，与员工实例里的 DSH 相同）能用这组地址、密钥和模型完成请求，不证明员工实例的出网路径；`rejected`（「模型服务拒绝了请求」）也可能只是服务商拒绝该最小请求参数（例如要求 `max_completion_tokens` 的推理模型），不一定是配置错误。
5. 在后台导航进入 `/_platform/admin/instances`，查看实例状态、最近启动/活动时间，展开出错实例的已保存安全日志。支持按邮箱本地筛选和显式刷新。重启与重置配置均需确认；重启提交不等于已就绪，重置不会自动启动。

自动化操作可使用下表中的同一公共接口，不得直接写数据库。JSON 写请求带 `Content-Type: application/json`、实际对外 `Origin`，登录后的请求携带该账号平台 cookie；凭据只保存在进程内或0600临时文件中，不打印请求头/响应cookie或完整模型配置。

| 操作 | 公共接口与关键结果 |
|---|---|
| 管理员/员工登录 | `POST /_platform/api/login`，JSON `{email,password}`；200及账号身份、平台session cookie |
| 保存模型 | 管理员 `PUT /_platform/api/admin/model-config`，JSON `{baseURL,apiKey,models:[{name}],defaultModel}`；200，回包只有 `apiKeyConfigured` 而非密钥 |
| 测试模型连接 | 管理员 `POST /_platform/api/admin/model-config/test`，JSON `{}`；200 `{result,httpStatus,elapsedMs}`，`result` 为封闭集代码（`ok`、`unconfigured`、`unauthorized`、`not-found`、`rejected`、`server-error`、`bad-response`、`timeout`、`unreachable`、`invalid-address`、`invalid-key`），不回显密钥、上游回应体或URL；只证明平台容器到模型的连通，不证明员工实例出网 |
| 注册员工 | `POST /_platform/api/register`，JSON `{email,password}`；201，记录返回的员工 `id`，再登录 |
| 启动实例 | 员工 `POST /_platform/api/instance/start`，JSON `{}`；200、`starting` |
| 等待就绪 | 员工 `GET /_platform/api/instance`；直到 `running`；终止错误不能当作继续重试的理由 |
| 原生入口 | 员工 `GET /` 返回原生HTML；`/api/remote.mux` WebSocket携带同一cookie、实际Host/Origin完成101和Ping/Pong |
| 停止一次性验收员工 | 管理员 `PUT /_platform/api/admin/users/<本次员工id>/status`，JSON `{"status":"disabled"}`；成功为204无响应体，撤销平台会话并退役实例，卷保留 |

模型配置PUT的 `models` 每项只允许 `name` 和可选 `contextWindow`；如 `contextwindow` 拼写错误或任意额外键，整个请求返回400，原设置、密钥及审计不变。顶层未知键也被拒绝。此规则落实既有OpenAPI声明，不收紧共享存储解析器：历史模型条目含额外字段时仍按既有规则读取并只返回已知字段，GET不改写历史设置。

一次性无推理部署验收允许配置明确标为测试的不可用模型地址/假值，仅验证保存和原生入口；不得把它用作生产默认或宣称模型调用通过。完整契约见 [`schemas/openapi.json`](../schemas/openapi.json)。

## 6. HTTPS、运行检查和故障边界

平台本身仍只提供 HTTP。已有反向代理负责终结 TLS，转发 WebSocket，并保留外部 Host（含端口）和 Origin；替换客户端伪造的转发头，设置真实客户端来源。把实际代理 IP 填入受信清单，对外地址改为 `https://...`，并独立开启 `PLATFORM_COOKIE_SECURE=true`。代理须允许至少 16 KiB 的上游响应头（nginx 设 `proxy_buffer_size 16k;`）；默认的 4 KiB/8 KiB 缓冲在平台回应带较多 `Set-Cookie` 时会返回 502。证书签发、更新和代理安装不在本阶段交付范围；仓库测试代理不是生产代理软件。

**多人共用一个浏览器（#372）**：所有员工实例共用平台这一个浏览器 origin，员工能完全控制自己实例返回的内容。平台为此按登录会话区分工作台缓存（`Vary: Cookie`），拒绝经网关注册 Service Worker（403），在登录、注册和登出后清理本地存储、IndexedDB、Service Worker、CacheStorage 和脚本可见的 cookie，并清除实例脚本种在更深路径上的同名 `platform_session`（包括不带 `=`、被浏览器存成无名 cookie 的写法）。其他名称的脚本 cookie 只按当前主机名清除，不删其他内网系统设在共同父域上的 cookie。

- **升级到本版本后**，在每个共用的浏览器配置中清除一次浏览数据：升级前缓存的条目不带 `Vary`，此前注册的 Service Worker 也不受 403 拦截，脚本都清不掉。
- 剩余风险：
  - 员工自己的会话内，其实例返回的脚本照常运行；
  - 上一位用户仍打开的页面，或用「后退」从往返缓存恢复的页面，会带着浏览器当前的 cookie 继续运行；Chromium 的 Blink 内存缓存不按 `Cookie` 区分，同一标签页里直接换人登录时仍可能执行上一位用户实例给的脚本，关闭上一位用户的全部标签页后再登录则不会；
  - 遮蔽 cookie 所在路径不是登录请求会带上的路径（例如 `/_platform/api/session`）时，第一次带上它的平台接口返回一次 401 并清除它，页面会回到登录页一次；
  - 自愈在 3 KiB 的 Set-Cookie 值预算内尽力而为（整个响应头块最坏约 4 KB，因此代理必须按上文允许 16 KiB），按固定优先级先清主机限定形式；超出预算的形式（很深的路径、多级父域、分区形式）不发，需要清除站点数据；
  - 实例脚本设在共同父域上的其他名称 cookie 不会被清除（以免删除其他内网系统的 cookie），之后的用户仍能读到；
  - cookie 总量超过请求头上限（431）时平台无法自愈，需要清除站点数据；只种在工作台 WebSocket 路径上的遮蔽 cookie，若浏览器不接受被拒绝握手里的 Set-Cookie，也需要清除站点数据。
- 建议每人使用自己的浏览器配置；交接时先登出，并关闭上一位用户的全部标签页。

`pnpm test:deploy` 在 giap-vps 的**独立临时验收环境**验证直连、持久化、端口/socket边界、HTTPS/WSS、双员工HTTP/原生Session长连接及实例内部隔离；需要固定平台名称空闲，不能在生产平台旁边运行。它使用自己的测试配置和资源，不验证你已经运行的生产部署。原始 `pnpm test:docker` 还需要 [AGENTS.md](../AGENTS.md) 所述隔离浏览器运行时；不要拿历史成功替代当前提交证明。

受信验收可由本机完成最终审查提交的 Linux/amd64 镜像构建，再通过可信 SSH 传输。运维方核对源提交、导出文件大小/SHA256和 OCI 内容摘要，将三个角色的布局保存在私有目录，并准备0600映射文件：顶层 `roles` 下的 `user`、`platform`、`browser` 各含绝对路径 `layout`、运行平台 manifest 的 `manifestDigest` 和 `configId`（两者都是完整 `sha256:` 摘要）。设置 `DSH_TEAM_VERIFICATION_IMAGES=/绝对路径/images.json` 后仍运行原始 `pnpm test:docker`、`pnpm test:deploy`；浏览器、主机和工具链先决条件不变。

布局须由验收用户本人解包并持有：目录0700，manifest/config blob为0600普通文件且只有一个硬链接，不接受软链接或硬链接。解包后对本次自有布局执行 `chmod -R go-rwx <布局目录>`；只把上层目录设为0700不足以满足文件检查。

使用受信持久化入口时，在 `pnpm --silent verify:docker start <reviewed-sha>` 的启动环境设置同一映射；脱离 SSH 的 owner 和完整测试子进程会保留该选择。保持映射和布局不变直到该 invocation 的真实工作与清理结清。不要为整个测试子进程强制设置 `umask 077`：跨 UID 的只读夹具需要声明的读取权限；私有记录由入口逐项创建为0700/0600。

私有日志验收仍要求所有非秘密字节顺序完全一致、0600权限和准确的字节数/SHA256；多 MiB 内容使用原生字节比较，避免通用对象比较自身耗尽测试期限，不减少内容校验或增加期限。

此入口只消费运维方已核验的本地 OCI 文件，不提供通用归档导入/构建管理接口。每个用例仍产生自己的带归属标签镜像，只有标签可变，完整文件层和运行配置必须匹配；没有共享基础镜像删除权。选定输入损坏时拒绝，不偷偷回到 VPS 源码构建。输入布局须保留至实际工作及清理结束；旧提交的试跑、成功上传或元数据派生均不能代替最终提交的完整运行验收。未设置变量时保留原有源码构建路径。

部署审计夹具的平台停止仍请求30秒优雅期，仅该调用使用45秒命令期限以容纳完成/传输余量；普通观察仍为15秒，生产生命周期期限不变。受信主机上的 `pnpm test:docker platform/test/deployment-audit-stop.docker.test.ts` 用精确归属的平台验证真实20秒停止后exit0和重启，并用真实受限子进程验证超期失败、关闭后再传播及部署清理；不会以强杀平台代替优雅退出，也不调用外部模型。

部署验收通过本次调用生成的启动参数和私有挂载，观察未修改的已编译 Docker 客户端；不修改生产镜像、正式 Compose 文件、Docker socket 路由或 HTTP 字节。每次平台进程启动都有独立的观察凭据，包括同一容器ID停止后再次启动；容器替换也不能沿用前一代凭据。初始化、父进程绑定、每个请求的结清和写入进程退役分别验证，正常退出或资源当前不存在不能抹去丢失回应的请求。

单独部署验收的未确认观察证据保留在本次精确创建的私有目录，独立于普通镜像夹具的配置清理；受信 Docker owner 下的证据保留至最终独立评估。不要按目录前缀清除未知证据，或把夹具自身的完成记录当作容器/进程已经退役的证明。Docker 独立的编译客户端、真实 Unix HTTP 和子进程回归不替代 Linux 挂载、真实容器重启及最终完整 Docker 验收。

本地卷生命周期回归通过真实 Unix HTTP 取消活动中的创建响应，在规范客户端边界被动捕获拒绝，并核对同一错误对象经提交追踪进入消费者聚合错误；不依赖格式化错误文案。替换为无关错误的独立负控必须被拒绝，同时保留连接关闭、精确清理、无关卷保留和原提交未确认的检查。这只证明本地取消传播，不补作真实 Docker 验收。

隔离浏览器 exec 的客户端关闭、Docker 操作结果和执行能力退役也是三个不同事实。预期的救援中断可以保留 `operationOutcome: unknown`，但只有原驱动/创建者已退役、原浏览器身份不变且精确容器ID独立确认不存在，最终清理结果才可记录 `executionCapability: retired`。终态 `cleanup.browserExec` 为 null 或有界的数量/摘要投影，完整身份仍在原提交证据中；它不能把根测试命令的失败改成成功。缺失该字段的旧终态记录不自动补值或重新认领，保留原私有证据供明确处置。

阶段1各验收条款、实际测试名、按SHA绑定的最近运行结果及尚未签结事项见[阶段1验收对照](STAGE_1_ACCEPTANCE.md)。测试通过不替代生产目标机资格或后置人工白盒审查。

失败时先保留不含凭据的退出码、阶段和资源身份。配置缺失/非法会指名变量并停止启动；子网池不足、镜像缺失、实例错误必须处理根因。不要通过增加重试、延长门槛、放宽seccomp或手工删除不明网络端点获得绿色。

**未确认的实例创建（#192）**：平台在提交最终容器创建前，将不含模型密钥、DSH cookie或原始检查文档的尝试凭据写入私有数据库。创建回应丢失或后续检查失败时，状态保持安全的`error`，不转发旧端点，停止/禁用不能跳过未结清的尝试而宣称成功。新进程的启动对账会用持久凭据核对本次nonce、容器/镜像/账号身份、原网络和挂载，只退役精确匹配且从未启动的容器及其已验证网络；两卷保留。恢复本身不启动员工实例，之后通过原显式启动入口重试。

身份变化、曾启动/仍运行、不明网络端点或缺少匹配凭据时，平台保留资源并明确失败。没有已知容器ID且当前只看到404，也不能证明迟到的创建不会完成；不得靠等待固定时长、删除凭据行、改标签或按规范名称强制删除来解除隔离。需保留非敏感的尝试/资源身份，由授权运维核实原提交与资源归属；旧版本遗留且没有尝试凭据的资源不会获得追溯删除授权。原始`docker inspect`含环境凭据，不得贴入日志或工单。

仅当持久凭据及当前账号/旧索引不变、没有已知容器ID、规范容器明确404且原网络状态已验证时，对账可将其归类为该用户的隔离状态，完成其他实例检查后正常监听；该用户仍为`error`，凭据和桥接网络保留，不能假报停止。身份/拓扑冲突、数据库错误或Docker查询失败仍阻止启动，不作为可忽略错误。孤儿网络阶段会在原用户队列内再次检查最新尝试；普通及退出活动写回在尝试未结清时延后，保留合并后的观察，避免合法网关流量破坏恢复身份栅栏。

上述非致命分类要求原桥接网络仍存在且匹配。若未知容器ID的尝试对应网络已从规范名称和原ID查询中同时消失，对账仍保留凭据并阻止平台启动；网络消失不属于已批准的可继续服务情形。已知容器ID且已经验证删除的尝试，仍可按原部分清理恢复流程结清，不受此分类限制。

此能力增加迁移3的`creation_attempts`，不改写既有账号、设置、会话和历史审计。正常升级仍先排空旧平台所有者；存在未结清尝试时不能回退到不认识该表的旧生命周期实现，应保留数据库与凭据并用支持恢复的版本处理。本段只说明该状态的兼容性与隔离边界，不构成完整升级/备份恢复手册。

**验收构建诊断**：受限Docker验证命令的镜像构建失败，在原脱敏错误后附固定结构的终止类别、实际耗时、原期限、退出状态及允许的信号。`deadline`只来自观察到的超时动作/错误码，不由耗时或空退出状态推断。`lastObservedBuildHeader`最多保留stderr中最后一条完整、可识别的BuildKit头部的数字vertex/step、固定阶段及指令；不保留RUN正文、镜像地址、路径或原始错误。它不是活动顶点清单或根因：并发步骤、未知阶段和截断输出不能据此定位卡住的操作。同步/异步路径均保留原输出上限和进程退出确认，非build错误及精确资源不存在判断不变；此诊断不授予清理权限、不自动重试或增加期限，也不使缺少历史证据的旧失败变成已确诊。

错误码只读取自有数据属性，不执行异常对象的getter；无法安全读取的可选元数据归为`unknown`。最终兜底用新的固定错误记录承载允许的基本值，不保留原异常对象、消息或cause，防止诊断本身抛错绕过脱敏。

### 共享验证 daemon 的 history 诊断禁令

**禁止在共享验证 daemon 上执行 BuildKit/Buildx history 查询，尤其是已触发事故的 `docker buildx history ls --filter status=error --format json`。只读命令不等于对 daemon 无副作用。** 不把它作为构建失败后的取证步骤，也不为本禁令在共享主机复现或静默升级 daemon；优先读取本次已经保存的脱敏退出、阶段和清理凭据。

[事故记录与后续更正（#266）](https://github.com/DankerMu/dsh-team/issues/266)确认：2026-10-17，父级助手主会话为找回构建失败信息直接发起该查询，并非仓库验证脚本自动调用。受影响组合为 Docker Engine29.1.3、Buildx v0.30.1（Ubuntu包`0.30.1-0ubuntu1~24.04.1`；版本由独立version查询取得，未重跑history）。客户端退出1并收到gRPC `Unavailable`/EOF；daemon在vendored BuildKit的`ListenBuildHistory`、`HistoryQueue`/`Listen`、`filterHistoryEvents`、`parseFilters.func1`、`parseFilter.func1`路径发生nil-pointer panic，栈指向`history.go:1195`，随后以`status=2/INVALIDARGUMENT`退出并由systemd重启。

四个无关的原运行容器因此停止；之后按用户独立授权、核对原身份后恢复，未重建，原ID、配置、挂载和网络身份保持不变。三个已配置健康检查为healthy，另一个未配置健康检查；这不是更广的应用内容验收。日志采集窗口08:58:09–08:58:12不是恢复耗时，现有证据没有精确中断时长。仅确认history-filter路径的nil dereference，具体nil事件、更深原因及修复版本均未知；不得与此前独立的`docker0`删除缺陷建立未经证明的因果关系，也不改变PR264的隔离修复范围。任何后续宿主/共享工作负载恢复仍须单独授权。

**当前没有获准解除禁令的版本组合。** 只有识别到明确候选修复pin后，才可在一次性、可销毁且与共享宿主网络隔离的daemon中资格验证；不得指向共享socket、数据目录或网络命名空间。记录Engine和Buildx的精确版本/包或镜像摘要、查询、daemon进程身份及前后状态、退出/栈证据和自有资源清理，证明查询未使daemon panic或退出后，才能为该已验证组合及查询明确更新文档许可；一次客户端exit0不能替代daemon存活证据。未验证的版本/查询仍禁用，共享daemon升级仍是另行授权的运维变更。本次仅交付操作边界，不包含候选修复资格验证或Docker/BuildKit代码修改。

## 7. 隔离提供什么、不提供什么

以下是交付的边界及验收位置，不代表阶段19全部对抗性验收已经结束：

- 每个员工单独的 home/work 卷、DSH进程与Session；平台按当前账号路由。`test:deploy` 的19.1用例用两名真实员工验证Session列表/读取、工作区文件列表/读取和文件下载：B携带A的用户/Session标识及伪造转发头，仍只取得B的数据或明确拒绝；员工调用当前各管理接口均为403。额外RPC参数由原生描述符拒绝，不能把该拒绝冒充已验证正确路由，因此另用合法参数核验B的独有内容。有限路由族覆盖不是所有URL的穷举。
- 19.2通过真正的`session/follow`逻辑流核验长连接：A/B各自取得绑定自身Session的快照和实时改名事件，B在同一carrier请求A的Session得到`session/not-found`且无内容，之后B原流继续收到自己的事件。101握手/Pong或等待超时不是此验收；不宣称覆盖全部原生流端点或实例内部越界。
- 19.3在B内以uid1001执行真实命令：A已读回的home/work标记在B的同路径及A的宿主卷路径均不可读，Docker socket不存在且读取/调用失败；A的3080/3099在本机、IP和别名持续可达，B按IP/别名均连接失败。B能写自己的工作区、访问平台health200，但无平台会话访问管理用户接口为401；覆盖层覆盖写返回EROFS，删除/替换失败且摘要不变。跨卷rename可先返回EXDEV，不能把该结果单独归因为只读挂载。这里不是65535端口穷举、平台数据全扫描或真实Yolo Agent验收；后两项分别属于19.4/19.5。
- 每个实例只加入自己的bridge网络；实例间地址/主机名不可达，平台分别接入各实例网络。停止一个实例不应影响兄弟实例；网络身份不可信时失败，不强制删除不明端点。
- 部署实例不发布宿主端口、不挂Docker socket、不使用特权模式；uid1001运行。只有平台持有Docker控制权限。`published-loopback`只是显式宿主开发方式，不满足部署无端口映射边界。
- 实例不持有平台数据库、密码哈希、平台session或管理员凭据；A的DSH凭据不能在B使用。平台API在来自实例的请求上仍鉴权：无平台session为401，员工调用管理接口为403。
- 19.4直接对真实原生端点验证：各自cookie返回200、启动令牌换出的cookie可用，A cookie/令牌在B返回401且不签发cookie，B仍可正常访问。另在B内以uid1001遍历可读普通文件和进程环境，查找本次全部注册/登录平台session值及存储摘要、密码哈希、A原生凭据；同时检查平台DB名称/SQLite schema/挂载来源。扫描先于凭据互换，探针参数不作为应用数据扫描；文件/环境正向标记必须命中。虚拟设备、sysfs和proc内存不扫描，proc仅读取进程environ；权限拒绝和已消失条目计数，未知错误或250000文件/4GiB/60秒边界超限即失败，不截断后通过。该有限可读视图不是原子文件系统快照或内核内存保密证明，也不把共用模型密钥列为禁止项。
- 19.5使用单独的`pnpm test:model`案例，在同一交付Compose上让真实B Agent选择Yolo，执行19.3相同的两组规范命令，复用全部五类拒绝与独立正向/后状态判据。原生Session历史必须绑定原始提示、唯一bash调用、完整工具结果和完成turn，且无审批、失败provider尝试或命令替换；模型声称“失败”不算证据。发行版bash只持久化渲染文本，要求完整JSON，拒绝stderr、截断、非零退出、超时和后台标记。该模型案例只在新批准的冻结SHA一次性通道运行，普通部署/Docker测试不调用模型；证据位于受信worker采集的`.run/issue82/yolo-isolation-*`。真实模型验收与授权状态以对应PR当前SHA证据为准，非模型资格验证不能替代它。
- 原生历史读取固定一次projection游标，每页仍为10条消息，按`beforeSeq`补齐较早页直至序号0；元数据前缀也必须保留。缺页、重复、重叠或游标之外事件均拒绝，不能以增大页限或忽略`hasMore`掩盖不完整证据。
- `permission-intended-bash`只表示原生调用身份判据拒绝，不表示隔离逃逸。新诊断detail按固定顺序给出turn/tool/command/call-id/order的本地布尔结果，不含输入命令、工具名、ID或对话；旧回执detail=null不能据此追溯具体原因。保持原命令完全相等、唯一调用和时序要求，不自动重试模型。
- 19.6在开启普通info日志的临时Compose中完成注册、登录、原生对话、改密码、模型配置更新和禁用；对实际审计表全部原始列/行及平台完整stdout/stderr搜索本次每个密码、注册/登录/换发会话、DSH启动令牌/cookie、模型密钥和消息标记。必须有真实操作记录及末端请求完成屏障；空数据、缺失库存和截断不能通过。对话使用受管provider连接测试自有本地确定性响应服务，不访问外部模型、不伪造Session事件。只报告数量/布尔结果，不保留原始日志、审计内容或匹配凭据；这是本次有限原文扫描，不是任意编码或内存保密证明。
- 19.7沿用同一真实部署操作链，补齐启用、重置密码、登出、TTY提升管理员、运行参数修改、重启、重置和实际空闲回收；十九种审计事件逐条校验操作者/对象，停止原因覆盖idle/admin/disabled/error。启动失败必须来自真实创建后启动或就绪失败，不能把创建前配置解析拒绝当作该事件；测试自有退出插件不进入交付镜像。新增凭据仍进入完整审计/日志扫描，无审计种子、假时钟或外部模型调用。
- 受管覆盖层在实例内只读；权限档位包括Yolo不能把它变为可写。DSH工具沙箱工作区限制由第4节的**显式交付策略**真实driver验证，而不是仅凭Docker启动成功或放宽级探针成功。
- **不提供模型密钥对员工的保密隔离：共用模型密钥在实例内可读。** 需采用最小权限、配额和可撤销的模型凭据。
- 受管 provider 只在隔离凭据存储 `dsh-team-platform` 中解析密钥引用：存储目录 `/opt/dsh-team/credentials` 为 root 所有的 0555 空目录，取值落到平台注入的进程环境变量，员工在自己 `.credentials.yaml` 中写入的同名值不生效。已接受的残余风险：任何能写补丁行的层（含员工可写的 `$DSH_HOME/cordis.patch.yml`）可用同一 `isolate` 标签加入该存储域并挂载另一个凭据实现；平台变量缺失时会回落到 `.env`（平台总是注入该变量）；设置页仍显示全局存储的凭据状态（仅显示）；该存储不可写，pi-ai OAuth 登录失败（本项目不使用）。
- **不提供实例对其余内网的默认出站阻断：实例可访问宿主机所在内网的其他地址。** 需要更强限制时由网络管理员设计边界，不能宣称现有用户间隔离等于内网全面隔离。
- 共享单机内核不是独立虚拟机；管理员与Docker操作者是可信边界。没有多机HA或已认证的60并发容量保证。

本阶段不交付 RAGFlow/ONLYOFFICE集成、离线包、升级回滚、备份恢复和生产TLS证书管理。需求与边界来源：[instance-isolation规格](../openspec/specs/instance-isolation/spec.md)、[基线](REQUIREMENTS_BASELINE.md)、[实施计划](IMPLEMENTATION_PLAN.md)。

## 8. 停止与一次性验收清理

正常停止平台**不删除数据卷，也不等于停止全部员工实例**。先停止新的用户工作，按管理员操作退役需要停止的员工；等待平台完成在途helper清理。对于已确认归本部署所有的平台ID，可发送SIGTERM并等待正常退出；超时/非零退出需要保留故障证据，不把强杀当作正常退役。

管理员可携带当前平台会话与匹配的Origin，向 `POST /_platform/api/admin/instances/:userId/reset-config` 提交JSON `{}`。平台先断开该员工网关连接并停止实例，再调用编排器 `restoreUserProfiles`，恢复和 `instance.config-reset` 审计都成功后返回空204。重置不会自动启动实例或撤销平台会话；随后由员工显式启动或管理员重启，按正常模型配置、容量和就绪流程进入工作台。已有且活跃的目标账号才可重置；未创建实例404，禁用/启动中/冲突操作409，未接入生命周期服务503。实例页提供同一操作，并在提交前说明“会恢复该用户的 DSH 设置，文件和对话保留”。

`restoreUserProfiles` 只恢复已退役实例的 `profiles/`：使用捕获的用户镜像、无网络uid1001一次性容器，只挂载已有且归属正确的home卷；`sessions/`、`storages/`、`attachments/`、`.credentials.yaml`、其他home数据与整个work卷保持不变。原目录中的符号链接不会把删除导向外部。HTTP调用方断开不取消已接纳的恢复；同用户启动/冲突管理操作不能穿插，平台关闭会等待实际恢复与清理。停止后、恢复前重查管理员权限；审计失败返回安全500，不声称已完成的文件恢复已回滚。

恢复时禁用Docker空卷copy-up，避免凭空重建`storages/`等非profile路径；首次普通启动仍保留镜像种子填充。恢复或清理失败必须报告失败结果；部分复制不承诺原配置回滚。无论是配置组合还是恢复helper，未确认的创建/清理都会在当前owner内阻止该用户后续启动和恢复，避免新的工作与潜在写入重叠。需要运营者按精确实例与invocation身份确认资源已结清；仅重启平台、找不到某个名字或按前缀删除都不是恢复完成证明。

一次性干净主机验收结束时，按以下顺序清理；这不是生产卸载脚本：

1. 保留本次创建的员工ID、平台ID、两个image ID、Compose project及数据根目录记录。开始前即存在的资源一律不删。
2. 通过上面的管理员状态接口禁用本次员工，关闭测试HTTP/WebSocket连接；确认该员工容器和网络已退役。若操作失败，保留错误并按精确ID及`dsh-team.user=<id>`标签核对后处理，不按名字前缀强制接管。
3. 校验固定平台名称的ID与记录一致、`com.docker.compose.project`等于本次project。`docker kill --signal SIGTERM <平台ID>`，然后 `timeout 30 docker wait <平台ID>`；要求输出0，并inspect确认已停止、ExitCode0且未OOM。
4. 用同一project/env-file/compose文件执行 `docker compose ... down`，移除已停止的平台和本次Compose网络；不要加 `--remove-orphans` 或 `--volumes`。
5. 对本次每个员工的 `dsh-team-home-<id>`、`dsh-team-work-<id>`，确认标签`dsh-team.user`精确匹配、无任何容器引用后，逐个 `docker volume rm <精确卷名>`。卷含员工数据；只有明确的一次性验收才执行。
6. 检查两个本次构建标签仍指向记录的image ID且`dsh-team.deploy-run`等于本次标识，再 `docker image rm dsh-team-user:local dsh-team-platform:local`；不使用force，不删除别人的标签/镜像。
7. 检查容器、镜像、卷、网络中所有`dsh-team`前缀项；它们只是残留告警，不是删除授权。只处理已证明本次创建的资源；任何不明项都使“干净结束”验收阻塞。禁止`docker system prune`、全局volume prune或按前缀批量删除。
8. 最后删除本次私有配置副本和已记录的测试数据目录。生产数据/既有配置不在此清理范围，不能复用本节进行升级或恢复。

本指南的干净检出演练、完整命令结果和最终资源清单随对应PR发布；不能用`pnpm test:deploy`自报替代本指南逐步演练。
