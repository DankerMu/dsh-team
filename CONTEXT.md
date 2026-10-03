# CONTEXT.md

> Project identity, bounded contexts, and business invariants for this repository.
> `AGENTS.md` is the operating contract; `openspec/glossary.md` defines the domain vocabulary; this file defines the domain boundaries and invariants that agents must respect when applying both.

## Project Identity

「交付一个单机 Docker 部署的平台，满足基线全部功能需求，并通过基线第 7 节的 14 条验收。DSH 源码不改；所有定制通过平台代码、DSH 插件、受管覆盖层和镜像构建完成。」（`docs/IMPLEMENTATION_PLAN.md` §1）

- **Primary users / consumers**: 内网员工（每人一个实例）和一名管理员。
- **Business goal**: 员工用邮箱注册登录后，直接进入自己的 DSH 使用内网模型、知识库和 Office 编辑，互不可见。
- **Lifecycle**: 生产使用，按年计；完全离线运行。

## Domain Language

Canonical terms and their prohibited aliases live in `openspec/glossary.md`. Read it before naming a domain concept; never define a term here.

## Bounded Contexts

| Context                               | Owns                                                           | Key terms (defined in `openspec/glossary.md`) | Forbidden logic                                                              | Integration boundary                                                     |
| ------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 平台 (`platform/`)                    | 账号、平台会话、实例生命周期、网关、受管覆盖层、审计、管理后台 | 平台、实例、受管覆盖层、网关、平台会话        | 不实现模型代理；不读写用户的文件和 Session 内容                              | 通过 Docker Engine API 管理实例；通过 HTTP 和 WebSocket 把请求转发给实例 |
| 实例内插件 (`plugins/`)               | 知识库检索工具和界面、办公 Agent 预设                          | Session、知识库                               | 不持有 RAGFlow 密钥；不调用 RAGFlow 写接口；不引用平台代码                   | 通过插件自己注册的 HTTP 路由访问平台的只读代理                           |
| 用户镜像与部署 (`images/`, `deploy/`) | DSH 版本、预装插件、沙箱设置、离线交付包                       | 实例                                          | 不修改 DSH 源码（构建期补丁只针对 `dsh-better-sidebar`，版本不符即构建失败） | 平台用镜像启动实例                                                       |

## Core Invariants

- 一个用户恰好一个实例；用户 A 的任何请求（HTTP、WebSocket、上传下载）都到不了用户 B 的实例。
- 受管覆盖层的值优先于用户在实例里做的任何配置修改。
- 浏览器只持有平台会话 cookie；DSH 的启动令牌和 cookie 只存在于平台服务端。
- 账号被禁用后，该用户的平台会话和长连接失效，实例停止。
- 实例停止或重建后，用户的文件和 Session 仍在。
- 审计日志不含密码、密钥和对话内容。
- 模型提供方、可选模型和默认模型由管理员配置，用户只能在给定范围内切换。

## Public Interfaces and Contracts

| Interface                    | Contract source                                     | Backward compatibility rule          | Test seam                                   |
| ---------------------------- | --------------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| 平台 HTTP 接口               | `schemas/openapi.json`（由路由生成）                | 改路由必须同时提交重新生成的契约文件 | `pnpm contract:check`、`smoke/*.hurl`       |
| 实例启动方式                 | `docs/IMPLEMENTATION_PLAN.md` T3、T4                | 钉定 DSH 版本，升级前重新验证        | `verify/phase0/`（阶段 1 起由集成测试接替） |
| RAGFlow HTTP API（只读使用） | `docs/DSH_Enterprise_Architecture_Analysis.md` §3.4 | 钉定 v1.0.0-rc1                      | 阶段 2 的联调测试                           |

## Forbidden Logic & Irreversible Operations

| Rule                                                                                 | Scope                        | Why                                  |
| ------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------ |
| 不修改 DSH 源码                                                                      | 全仓库                       | 决定 D1；升级 DSH 时不背补丁         |
| 不对 RAGFlow 做任何内容写操作                                                        | 平台、插件                   | 现有知识库由别的系统维护，本项目只读 |
| RAGFlow 密钥只留在平台后端，不进浏览器、不进用户 shell                               | 平台、插件                   | 用户不得绕过平台直接访问知识库       |
| 密钥不写进文档、回复、提交和日志；测试模型密钥只从环境变量 `DMXAPI_KEY` 读取，不打印 | 全仓库                       | 仓库是公开的                         |
| 不改动现有的 RAGFlow、Office、模型服务                                               | 部署                         | 它们是别人在用的共享服务             |
| 不对 `resource/` 下的参考仓库做 reset、clean、checkout                               | 本机                         | 只读参考，可能有他人未提交的改动     |
| 字体不入库                                                                           | `assets/fonts/`              | 授权只覆盖部署使用，不覆盖公开分发   |
| 删除实例的数据卷必须由管理员显式触发，且不可恢复                                     | `platform/src/orchestrator/` | 卷里是用户唯一的文件和 Session       |
| 后台不提供浏览员工文件和对话的功能                                                   | `platform/src/admin/`        | 基线 F5                              |

## Open Terminology Questions

| Question                           | Why it matters                              | Candidate terms                | Owner    |
| ---------------------------------- | ------------------------------------------- | ------------------------------ | -------- |
| DSH 的 preset 在界面和文档里叫什么 | 需求书用“Agent”，DSH 用“preset”，两者会混用 | 办公 Agent / 预设              | DankerMu |
| 权限三档的正式名称                 | 界面、覆盖层和文档要一致                    | 人工批准 / 自动审查 / 完全放行 | DankerMu |
