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
  --build-context office-agents=plugins/office-agents images/dsh-user

docker build --label "dsh-team.deploy-run=$DEPLOY_RUN" \
  -t dsh-team-platform:local -f platform/Dockerfile .

docker image inspect --format '{{.Id}}' dsh-team-user:local dsh-team-platform:local
```

记录两个不可变 image ID。用户镜像内 DSH 固定为 `0.2.0-rc.2`，包含中文界面、权限插件、办公预设和 python-docx；平台多阶段镜像含编译服务、CLI、前端、迁移和 native SQLite 依赖，不依赖宿主源码挂载。不要省略三个 named context。

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

在**真实交互终端**创建管理员（将邮箱换成自己的）：

```sh
docker compose --project-name "$DEPLOY_PROJECT" --project-directory . \
  --env-file .env -f deploy/compose.yml exec platform \
  node platform/dist/cli.js admin create admin@example.test
```

不要加 `-T`，不要把密码放在参数或环境变量里；按两次隐藏提示输入密码。创建成功后：

1. 用对外地址访问 `/_platform/login`，管理员登录后进入 `/_platform/admin/models`。
2. 填写真实模型服务 Base URL、密钥、模型名和默认模型，保存。密钥不回显；更新配置不热切换已运行实例，下次启动/管理员重启生效。
3. 用独立员工账号访问 `/_platform/register` 注册，再登录。进入等待页后应启动自己的实例并进入原生工作台。
4. 检查原生页面及 WebSocket 连接；模型连通性另行用批准的真实任务验收。仅保存模型配置和打开工作台不代表推理成功。
5. 在后台导航进入 `/_platform/admin/instances`，查看实例状态、最近启动/活动时间，展开出错实例的已保存安全日志。支持按邮箱本地筛选和显式刷新。重启与重置配置均需确认；重启提交不等于已就绪，重置不会自动启动。

自动化操作可使用下表中的同一公共接口，不得直接写数据库。JSON 写请求带 `Content-Type: application/json`、实际对外 `Origin`，登录后的请求携带该账号平台 cookie；凭据只保存在进程内或0600临时文件中，不打印请求头/响应cookie或完整模型配置。

| 操作 | 公共接口与关键结果 |
|---|---|
| 管理员/员工登录 | `POST /_platform/api/login`，JSON `{email,password}`；200及账号身份、平台session cookie |
| 保存模型 | 管理员 `PUT /_platform/api/admin/model-config`，JSON `{baseURL,apiKey,models:[{name}],defaultModel}`；200，回包只有 `apiKeyConfigured` 而非密钥 |
| 注册员工 | `POST /_platform/api/register`，JSON `{email,password}`；201，记录返回的员工 `id`，再登录 |
| 启动实例 | 员工 `POST /_platform/api/instance/start`，JSON `{}`；200、`starting` |
| 等待就绪 | 员工 `GET /_platform/api/instance`；直到 `running`；终止错误不能当作继续重试的理由 |
| 原生入口 | 员工 `GET /` 返回原生HTML；`/api/remote.mux` WebSocket携带同一cookie、实际Host/Origin完成101和Ping/Pong |
| 停止一次性验收员工 | 管理员 `PUT /_platform/api/admin/users/<本次员工id>/status`，JSON `{"status":"disabled"}`；成功为204无响应体，撤销平台会话并退役实例，卷保留 |

一次性无推理部署验收允许配置明确标为测试的不可用模型地址/假值，仅验证保存和原生入口；不得把它用作生产默认或宣称模型调用通过。完整契约见 [`schemas/openapi.json`](../schemas/openapi.json)。

## 6. HTTPS、运行检查和故障边界

平台本身仍只提供 HTTP。已有反向代理负责终结 TLS，转发 WebSocket，并保留外部 Host（含端口）和 Origin；替换客户端伪造的转发头，设置真实客户端来源。把实际代理 IP 填入受信清单，对外地址改为 `https://...`，并独立开启 `PLATFORM_COOKIE_SECURE=true`。证书签发、更新和代理安装不在本阶段交付范围；仓库测试代理不是生产代理软件。

`pnpm test:deploy` 在 giap-vps 的**独立临时验收环境**验证直连、持久化、端口/socket边界、HTTPS/WSS、双员工HTTP/原生Session长连接及实例内部隔离；需要固定平台名称空闲，不能在生产平台旁边运行。它使用自己的测试配置和资源，不验证你已经运行的生产部署。原始 `pnpm test:docker` 还需要 [AGENTS.md](../AGENTS.md) 所述隔离浏览器运行时；不要拿历史成功替代当前提交证明。

失败时先保留不含凭据的退出码、阶段和资源身份。配置缺失/非法会指名变量并停止启动；子网池不足、镜像缺失、实例错误必须处理根因。不要通过增加重试、延长门槛、放宽seccomp或手工删除不明网络端点获得绿色。

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
- **不提供实例对其余内网的默认出站阻断：实例可访问宿主机所在内网的其他地址。** 需要更强限制时由网络管理员设计边界，不能宣称现有用户间隔离等于内网全面隔离。
- 共享单机内核不是独立虚拟机；管理员与Docker操作者是可信边界。没有多机HA或已认证的60并发容量保证。

本阶段不交付 RAGFlow/ONLYOFFICE集成、离线包、升级回滚、备份恢复和生产TLS证书管理。需求与边界来源：[instance-isolation规格](../openspec/changes/stage-1-accounts-instances/specs/instance-isolation/spec.md)、[基线](REQUIREMENTS_BASELINE.md)、[实施计划](IMPLEMENTATION_PLAN.md)。

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
