# 阶段 2：本机全栈验证通道

本机通道 `pnpm test:stack` 在开发机（macOS arm64）上构建当前提交的平台镜像和用户镜像，用交付的 `deploy/compose.yml` 拉起平台，连接本机的 RAGFlow 测试栈，并经平台网关用 Playwright Chromium 驱动真实 DSH。

它是**本机功能证据通道**：
- 浏览器是仓库钉定的 Playwright Chromium，不是 VPS 上的隔离 CfT 浏览器，不提供隔离证据。
- 对话模型是测试自有的确定性 provider，不调用外部模型。
- arm64 上的结果不代表 amd64 生产环境。

giap-vps 上 `pnpm test:docker` 与 `pnpm test:deploy` 的门禁不变，本机通道不替代它们，也不是 CI 必需检查。

## 1. 前提

`pnpm test:stack` 在创建任何资源之前逐项检查以下前提，任一项不满足就以非零状态退出并说明原因：

- 主机是 macOS arm64，本机 Docker 可用，并且没有设置 `DOCKER_HOST`、`DOCKER_CONTEXT`。
- `docker info` 报告的 MemTotal 不低于 14 GiB。可以在 Docker Desktop 的 Resources 里调整。
- 私有配置文件 `~/.config/dsh-team/stack.json` 存在、归当前用户所有、权限为 0600，格式见第 3 节。
- Docker Compose 2.33.1 或更新，`docker buildx` 可用。本通道使用私有的 Docker 配置目录，会自动指向 Docker Desktop 自带的插件目录。
- `/usr/bin/python3` 可用，并且带 `fcntl` 模块。部署锁由它持有。
- 钉定的 Playwright Chromium 已安装。首次使用前运行：

  ```bash
  pnpm install
  pnpm test:ui:install
  ```

- 本机 RAGFlow 测试栈可达，版本接口报告 `v1.0.0-rc2`，部署方法见第 2 节。

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
- Infinity 改用 x64 镜像，在 arm64 上经仿真运行。
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

`~/.config/dsh-team/stack.json` 归当前用户、权限 0600、不超过 16 KiB，必须恰好是下面三个键的 JSON 对象：

```json
{
  "ragflowUrl": "http://127.0.0.1:19380",
  "ragflowApiKey": "<第 2 节创建的 RAGFlow API 密钥>",
  "embeddingApiKey": "<第 2 节配置的嵌入模型提供方密钥>"
}
```

```bash
mkdir -p ~/.config/dsh-team && chmod 700 ~/.config/dsh-team
chmod 600 ~/.config/dsh-team/stack.json
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
- 可以带一个与私有配置字节相等的地址参数，例如 `pnpm seed:stack http://127.0.0.1:19380`；地址不一致时脚本在任何网络请求之前拒绝执行。
- 脚本没有删除、更新或停止解析的路径。解析失败时只报库名与文件名，并以非零状态结束。
- 库有 chunk 之后，RAGFlow 不允许再改嵌入模型。要换模型，先在 RAGFlow 界面删除这三个库，再重新运行 `pnpm seed:stack`。

## 5. 运行本机通道

```bash
pnpm test:stack
```

**一次运行做的事：**

1. 检查第 1 节的前提，然后把本次运行目录写到 stderr：`test:stack run directory <dir>`。
2. 运行 vitest 项目 `stack`，即 `platform/test/*.stack.test.ts`：
   1. 在本机构建两个镜像。
   2. 用 compose 拉起平台，检查 `/healthz`。
   3. 核对三个库共六个文件都已 `COMPLETED`。
   4. 在平台容器里启动确定性 provider，并把管理员模型配置指向它。
   5. 让员工经网关登录真实 DSH 并发一条消息。
   6. 核对回复显示在对话里，`/data/work` 下写出的文件与脚本逐字节一致；同时核对零控制台错误、没有对外 origin 的请求。
3. 截图保存在 `reports/stack/<runId>/`。
4. 结束后，按账本精确退休本次创建的容器、网络、卷和镜像，固定名平台先排空再删除。

**清理规则：**
- 资源统一使用 `dsh-team` 前缀和 `dsh-team.test-run` 标签。
- 用例进程组在 2 秒内没有结算、清理失败，或退休后按标签清点仍有残留时，运行目录和账本会保留，命令以非零状态结束。
- 账本保留后没有可以重新进入的退休入口，按以下顺序手工恢复：
  1. 确认运行目录记录的进程已不存在，并且没有其他部署入口持有 `/tmp/dsh-team-deployment.lock`。
  2. 对带本次 `dsh-team.test-run` 标签、ID 已核实的 `dsh-team-platform` 先执行 `docker stop`，并确认它正常退出（`ExitCode 0`、未 OOM）。
  3. 按容器、网络、卷、镜像的顺序，只删除账本列出且带本次标签的精确名。
  4. 删除运行目录。

  在此之前，遗留的 `dsh-team-platform` 会让下一次运行在准入时被拒绝。

## 6. 证据评论格式

涉及 RAGFlow 或 Office 的 PR 合并之前，在 PR 中贴出该 PR 精确 head 上 `pnpm test:stack` 的证据评论。本机通道不新增 CI 必需检查，也不改 workflow。证据评论至少包含：

| 项 | 内容 |
| --- | --- |
| 提交 | 精确 head SHA；运行时工作树没有已跟踪的改动 |
| 命令 | `pnpm test:stack`，以及主机的 Docker Desktop 与 Compose 版本 |
| 退出码 | 命令的实际退出码 |
| 用例计数 | vitest 报告的文件数与用例数，以及用例打印的 `stackEvidence` 行 |
| 清理 | 运行目录已删除；带 `dsh-team.test-run` 标签的容器、网络、卷为 0；带该标签的镜像清单与运行前相同 |
| RAGFlow 测试栈 | 运行前后的 `ragflow-rc2-*` 容器 ID、StartedAt、状态、重启次数与数据卷清单逐行一致 |
| 凭据 | 运行日志中没有密钥 |

最后注明：本机 arm64 结果只作功能证据，不代表 amd64 生产环境，也不作隔离证据。
