# 阶段 2：本机全栈验证通道

本机通道 `pnpm test:stack` 在开发机（macOS arm64）上构建当前提交的平台镜像和用户镜像，用交付的 `deploy/compose.yml` 拉起平台，连接本机的 RAGFlow 测试栈，并经平台网关用 Playwright Chromium 驱动真实 DSH。

它是**本机功能证据通道**：
- 浏览器是仓库钉定的 Playwright Chromium，不是 VPS 上的隔离 CfT 浏览器，不提供隔离证据。
- 对话模型是测试自有的确定性 provider，不调用外部模型。
- arm64 上的结果不代表 amd64 生产环境。

giap-vps 上 `pnpm test:docker` 与 `pnpm test:deploy` 的门禁不变，本机通道不替代它们，也不是 CI 必需检查。

## 1. 前提

`pnpm test:stack` 在创建任何资源之前按下面的顺序检查前提，任一项不满足就以非零状态退出并说明原因：

1. 没有设置 `DOCKER_HOST`、`DOCKER_CONTEXT`。
2. 主机是 macOS arm64。
3. 私有配置文件 `~/.config/dsh-team/stack.json` 存在、归当前用户所有、权限为 0600，格式见第 3 节。
4. 本机 Docker 可用，`docker info` 报告的 MemTotal 不低于 14 GiB（在 Docker Desktop 的 Resources 里调整）。本通道只在固定 PATH `/usr/local/bin:/usr/bin:/bin` 中查找 `docker`，所以 Docker Desktop 的 CLI 必须装在 `/usr/local/bin/docker`。只为当前用户安装 CLI 时，即使你自己的 shell 能运行 `docker info`，这一项也会以 Docker 不可用失败。
5. Docker Compose 2.33.1 或更新，`docker buildx` 可用。本通道使用私有的 Docker 配置目录，并从 `/usr/local/bin/docker` 的实际位置推出 Docker Desktop 自带的插件目录。
6. `/usr/bin/python3` 可用，并且带 `fcntl` 模块。部署锁由它持有。
7. 钉定的 Playwright Chromium 已安装。首次使用前运行：

   ```bash
   pnpm install
   pnpm test:ui:install
   ```

8. 本机 RAGFlow 测试栈可达，版本接口报告 `v1.0.0-rc2`，部署方法见第 2 节。

用例会停掉并重新启动测试栈的 `ragflow-rc2-ragflow-cpu-1`，以验证 RAGFlow 停机时平台照常工作（用户 2026-11-03 特批）。它只对这一个容器做 `docker stop` 和 `docker start`，不删除、不重建、不改配置；停之前核对容器的 compose 项目与服务标签，结束前等它恢复，并核对种子快照不变。

## 2. 部署本机 RAGFlow 测试栈

测试栈使用官方 `infiniflow/ragflow:v1.0.0-rc2`，上游文件保持原样，只加一个本机覆盖文件。下面以 `~/ragflow-rc2` 为工作目录。

```bash
mkdir -p ~/ragflow-rc2 && cd ~/ragflow-rc2
git clone --depth 1 --branch v1.0.0-rc2 https://github.com/infiniflow/ragflow.git src
```

在 `~/ragflow-rc2/compose.local.yml` 写入以下内容：

```yaml
# Local overlay for the arm64 dev host: emulated x64 Infinity (arm64 tags need glibc 2.38), and only the API + web UI
# are published, on loopback. Upstream files in src/docker stay as released.
services:
  infinity:
    image: infiniflow/infinity:v0.7.4-x64-v2
    platform: linux/amd64
    ports: !reset []
  mysql:
    ports: !reset []
  minio:
    ports: !reset []
  kvrocks:
    ports: !reset []
  nats:
    ports: !reset []
  ragflow-cpu:
    ports: !override
      - 127.0.0.1:19380:9380
      - 127.0.0.1:19080:80
```

这个覆盖文件做了两件事：
- Infinity 从上游的 `v0.7.4-x64-v3` 换成 `v0.7.4-x64-v2`，并固定 `platform: linux/amd64`，在 arm64 上经仿真运行（arm64 标签需要 glibc 2.38）。
- 只在 loopback 上发布 RAGFlow 的 API 端口 19380 和网页端口 19080；其他服务一律不发布端口。

启动和检查：

```bash
cd ~/ragflow-rc2
docker compose -p ragflow-rc2 -f src/docker/docker-compose.yml -f compose.local.yml up -d
docker compose -p ragflow-rc2 -f src/docker/docker-compose.yml -f compose.local.yml ps
curl -s http://127.0.0.1:19380/api/v1/system/version
```

- 上游自带的默认配置会选中 6 个服务：`ragflow-cpu`、`infinity`、`mysql`、`minio`、`nats`、`kvrocks`，不需要额外的 `--profile`。
- 版本接口应返回 `"data":"v1.0.0-rc2"`。

接着在浏览器打开 `http://127.0.0.1:19080` 完成三步：
1. 注册一个本机账号。
2. 在模型设置里配置嵌入模型的提供方与密钥，并把它设为租户默认的嵌入模型。种子脚本建库时不指定嵌入模型，直接使用这个默认值。
3. 在 API 设置里创建一个 API 密钥。

测试栈只服务本机验证。平台代码与测试只按第 3 节的私有配置访问它，不会删除或修改它的容器与数据卷。

## 3. 私有配置文件

`~/.config/dsh-team/stack.json` 归当前用户、权限 0600、不超过 16 KiB，必须恰好是下面三个键的 JSON 对象。先建目录和一个 0600 的空文件，再用编辑器写入内容：

```bash
mkdir -p ~/.config/dsh-team && chmod 700 ~/.config/dsh-team
touch ~/.config/dsh-team/stack.json && chmod 600 ~/.config/dsh-team/stack.json
```

```json
{
  "ragflowUrl": "http://127.0.0.1:19380",
  "ragflowApiKey": "<第 2 节创建的 RAGFlow API 密钥>",
  "embeddingApiKey": "<第 2 节配置的嵌入模型提供方密钥>"
}
```

规则：
- `ragflowUrl` 只接受字面 loopback 主机，即 `127.0.0.1` 或 `[::1]`，不接受要经解析的 `localhost`。这是「只写本机测试栈」的机械保证。
- 未知键、空值、控制字符、非法 JSON 都会被拒绝，错误信息里不含文件内容。
- `embeddingApiKey` 是封闭键集的一部分，但目前的脚本不会发送它。嵌入调用由 RAGFlow 以第 2 节配置的租户默认模型完成。
- 密钥不进命令参数、仓库文件、日志、测试报告、截图或证据评论。

## 4. 种子数据

```bash
pnpm seed:stack
```

- 种子脚本只对私有配置里的地址写入。它建立 3 个固定的库（`dsh-team-seed-policies`、`dsh-team-seed-products`、`dsh-team-seed-minutes`），每个库上传 2 个仓库内的小文本文件并解析。
- 已经存在并解析完成的数据会被复用。第二次运行不发出任何上传或解析请求。
- 可以带一个地址参数，例如 `pnpm seed:stack http://127.0.0.1:19380`。比较前两边各去掉一个结尾斜线，之后必须与私有配置字节相等；不一致时脚本在任何网络请求之前拒绝执行。
- 脚本没有删除、更新或停止解析的路径。解析失败时只报库名与文件名，并以非零状态结束。
- 库有 chunk 之后，RAGFlow 不允许再改嵌入模型。要换模型，先在 RAGFlow 界面删除这三个库，再重新运行 `pnpm seed:stack`。

## 5. 运行本机通道

```bash
pnpm test:stack
```

**一次运行做的事：**

1. 检查第 1 节的前提，然后把本次运行目录写到 stderr：`test:stack run directory <dir>`。
2. 运行 vitest 项目 `stack`，即 `platform/test/**/*.stack.test.ts`：
   1. 只读核对三个库共六个文件都已 `COMPLETED`，记下快照。
   2. 取得部署锁，在本机构建两个镜像。
   3. 用 compose 拉起平台，检查 `/healthz`。
   4. 在平台容器里启动确定性 provider，并把管理员模型配置指向它；管理员保存 RAGFlow 地址（`host.docker.internal:<端口>`）和密钥，测试连接成功。
   5. 停掉 `ragflow-cpu`（停之前在 stderr 写出被停的容器和恢复命令）。
   6. 在 RAGFlow 停机期间让员工经网关登录真实 DSH 并发一条消息；核对回复显示在对话里，`/data/work` 下写出的文件与脚本逐字节一致；同时核对零控制台错误、没有对外 origin 的请求。管理员的 RAGFlow 设置接口照常读取，测试连接报告 `unavailable`；从员工实例内调用四个代理接口，都返回 `unavailable`。
   7. 重新启动 `ragflow-cpu` 并等待就绪，再从员工实例内调用四个代理接口：版本、三个种子库、库内文件与文件名筛选、检索（含剔除伪造库）。管理员把相似度阈值改为 1 之后，下一次检索立即变为 `no-results`。
   8. 排空并拆除部署、释放锁之后，再读一次种子快照，要求与开始时相同；6 个 `ragflow-rc2-*` 容器的 ID、状态与数据卷不变；`ragflow-cpu` 的 `StartedAt` 和重启次数会变（`docker start` 把重启次数清零），其他 5 个容器的 `StartedAt` 和重启次数不变。
3. 截图保存在 `reports/stack/<runId>/`。
4. 结束后，按账本精确退休本次创建的容器、网络、卷和镜像，固定名平台先排空再删除。

**清理规则：**
- 资源都使用 `dsh-team` 前缀，并在创建之前写进账本，每条账本记录带着该资源的所有权标签：
  - 本次运行直接创建的镜像、探测容器、固定名平台 `dsh-team-platform` 和 compose 网络，带 `dsh-team.test-run=<runId>`。
  - 平台为员工创建的实例资源 `dsh-team-u-<id>`、`dsh-team-home-<id>`、`dsh-team-work-<id>`、`dsh-team-net-<id>`，带 `dsh-team.user=<id>`，不带运行标签。
- vitest 自己结束后，它的进程组要在 2 秒内结算。没有结算、清理失败，或退休后按 `dsh-team.test-run` 标签清点仍有残留时，运行目录和账本会保留，命令以非零状态结束。按运行标签的清点看不到员工实例资源，它们由账本的精确退休删除。
- 账本保留后没有可以重新进入的退休入口，按以下顺序手工恢复：
  1. 确认这次运行的整个进程组都已不在，即入口进程不在，以 vitest 主进程为组长的进程组（forks 工作进程、docker CLI 子进程和持锁进程）也不在。例如先用 `ps -ax -o pid,pgid,command | grep -E 'scripts/test-stack.mjs|node_modules/vitest'` 找到 vitest 主进程或其工作进程所在的 PGID（工作进程与主进程同组），再确认 `ps -ax -o pid,pgid,command` 里没有这个 PGID 的进程。同时确认没有进程持有 `/tmp/dsh-team-deployment.lock`（`lsof /tmp/dsh-team-deployment.lock` 没有输出）。手工恢复期间不持有部署锁，期间不要启动任何部署入口。
  2. 若账本里有 `dsh-team-platform`，按代码的排空方式处理（`platform/test/docker-cleanup.ts` 的 `drainDeploymentPlatform`）：
     - 先 `docker inspect dsh-team-platform`。容器已不存在就跳过这一步；存在时核实它带本次 `dsh-team.test-run` 标签，不带就停止，什么都不删。
     - 状态为 `created`（从未启动）时不需要排空，直接进入第 3 步。
     - 正在运行时执行 `docker kill --signal SIGTERM <ID>`，然后 `docker wait <ID>` 必须输出 `0`。
     - 对所有不是 `created` 的情况，再用 `docker inspect` 确认 `Running=false`、`ExitCode=0`、`OOMKilled=false`。任一项不满足就停止，什么都不删。
     - 不要用 `docker stop`：它在宽限期后发 SIGKILL，强制终止不能证明平台已排空。
  3. 按容器、网络、卷、镜像的顺序，逐条处理账本列出的精确名。资源已不存在就视为已退休、跳过；存在时核对它的标签与账本同一条记录里的所有权标签一致（以账本记录为准，不要按名字推断），一致才删除，不一致就停止。
  4. 删除运行目录，以及 `$TMPDIR` 下这次运行留下的 `dsh-team-test-docker-*` 私有目录（里面是平台数据、`compose.env` 和绑定源）。

  在此之前，遗留的 `dsh-team-platform` 会让下一次运行在准入时被拒绝。
- 用例停掉 `ragflow-cpu` 之后，只要 `docker stop` 已经提交，`finally` 就会重新启动它。但进程被强杀、`test-stack.mjs` 把 SIGINT/SIGTERM 转发给整个进程组，或 vitest 超时，都不会执行 `finally`，容器会停在停止状态，下一次运行的前提检查会以「RAGFlow test stack unreachable」失败。此时手工恢复：

  ```bash
  docker start ragflow-rc2-ragflow-cpu-1
  ```

  然后确认 `curl -s http://127.0.0.1:19380/api/v1/system/version` 报告 `v1.0.0-rc2`。这几种中断也会留下 `$TMPDIR/dsh-team-test-docker-*/platform-data/platform.db`，其中存着本机 RAGFlow 测试栈的真实密钥（目录 0700、只属于当前用户）；按上面的手工恢复步骤删除这些私有目录。

## 6. 证据评论格式

涉及 RAGFlow 或 Office 的 PR 合并之前，在 PR 中贴出该 PR 精确 head 上 `pnpm test:stack` 的证据评论。本机通道不新增 CI 必需检查，也不改 workflow。证据评论至少包含：

| 项 | 内容 |
| --- | --- |
| 提交 | 精确 head SHA；运行时工作树没有已跟踪的改动 |
| 命令 | `pnpm test:stack`，以及主机的 Docker Desktop 与 Compose 版本 |
| 退出码 | 命令的实际退出码 |
| 用例计数 | vitest 报告的文件数与用例数，以及用例打印的 `stackEvidence` 行 |
| 清理 | 运行目录已删除；带 `dsh-team.test-run` 标签的容器、网络、卷为 0；名字以 `dsh-team-` 开头的容器、网络、卷清单与运行前逐行相同（覆盖只带 `dsh-team.user` 的员工实例资源；`docker … --filter name=` 是子串匹配，按名字前缀筛选时容器用 `docker ps -a --format '{{.Names}}'`、网络和卷用 `--format '{{.Name}}'`，再加 `grep '^dsh-team-'`）；带运行标签的镜像清单与运行前相同 |
| RAGFlow 测试栈 | 运行前后的 6 个 `ragflow-rc2-*` 容器 ID、状态与数据卷清单一致；只有 `ragflow-cpu` 的 `StartedAt` 和重启次数因用例自己的停启而改变（`docker start` 把重启次数清零），其他 5 个容器逐行一致 |
| 代理 | 用例打印的 `stackEvidence.proxy`：停机期间四个接口与测试连接的结果、恢复后的版本、种子库数、文件数、检索结果与片段数、剔除数、改阈值后的结果 |
| 凭据 | 运行日志中没有密钥 |

最后注明：本机 arm64 结果只作功能证据，不代表 amd64 生产环境，也不作隔离证据。
