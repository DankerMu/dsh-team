## Purpose

在开发机 arm64 上连接真实 RAGFlow 测试栈和 Document Server 的本机全栈验证通道，以及测试栈种子数据和证据规则；它补充而不替代 giap-vps 的 Docker 门禁。

## ADDED Requirements

### Requirement: 本机全栈验证命令

仓库 MUST 提供根脚本 `pnpm test:stack`。它在本机 Docker 上构建当前提交的平台镜像和用户镜像，用交付的 compose 拉起平台和 Document Server，连接已运行的本机 RAGFlow 测试栈，并运行知识库和 Office 的端到端接口与浏览器用例。前提缺失时 MUST 在创建任何资源前失败，不能跳过用例或降级为部分验证：包括非 macOS arm64 主机、本机 Docker 不可用、可用内存不足、私有配置文件缺失或权限不安全、RAGFlow 不可达。

#### Scenario: 前提缺失时直接失败

- **WHEN** 私有配置文件不存在，或本机 RAGFlow 测试栈未运行
- **THEN** 命令以非零状态退出并说明缺失的前提，没有创建任何 Docker 资源

#### Scenario: 全栈用例通过

- **WHEN** 前提齐全，在一个已提交的干净检出上运行 `pnpm test:stack`
- **THEN** 知识库浏览、范围快照、检索来源、错误映射，以及 Office 编辑写回、跨用户攻击拒绝、旧格式预览的用例都在真实服务上执行并通过

### Requirement: 私有配置与凭据不外泄

RAGFlow 地址、密钥和嵌入模型密钥 MUST 只从开发机上的私有配置文件读取，该文件 MUST 归当前用户所有且权限为 0600。凭据 MUST NOT 出现在命令参数、仓库文件、日志、测试报告、截图或证据评论中。

#### Scenario: 权限不安全的配置被拒

- **WHEN** 私有配置文件对组或其他用户可读
- **THEN** 命令在读取内容之前失败，错误信息中没有文件内容

#### Scenario: 报告中没有密钥

- **WHEN** 一次运行结束，检查全部输出、报告和截图文本
- **THEN** 其中不包含 RAGFlow 密钥或嵌入模型密钥

### Requirement: 测试栈种子数据规模受控

仓库 MUST 提供只对本机 RAGFlow 测试栈执行的种子脚本，建立固定的少量知识库和小文件，并完成解析。已存在且解析完成的数据 MUST 被复用，不能重复上传或重新解析。种子脚本 MUST 拒绝对私有配置之外的地址执行写操作。

#### Scenario: 重复运行不重复解析

- **WHEN** 种子脚本第二次运行
- **THEN** 它识别已有的库和文件，不发起新的上传或解析请求

#### Scenario: 只写本机测试栈

- **WHEN** 种子脚本收到一个与私有配置不一致的 RAGFlow 地址
- **THEN** 脚本拒绝执行，不发出任何写请求

### Requirement: 本机资源自有并完整清理

本机通道创建的容器、网络、卷和镜像 MUST 使用 `dsh-team` 前缀和本次运行的标签，并在成功、断言失败和中途中断时只按精确所有权清理。它 MUST NOT 删除或修改 RAGFlow 测试栈本身的资源，也 MUST NOT 使用全局或前缀清理。

#### Scenario: 失败后不留自有资源

- **WHEN** 一个用例断言失败后命令结束
- **THEN** 本次运行创建的资源都已删除，RAGFlow 测试栈的容器和数据卷不变

### Requirement: 证据规则

涉及 RAGFlow 或 Office 的 PR 合并前，MUST 在 PR 中贴出该 PR 精确 head 上 `pnpm test:stack` 的证据评论：提交 SHA、命令、退出码、用例计数和清理结果。本机通道 MUST NOT 新增 CI 必需检查，也不改 workflow；giap-vps 的 `test:docker` 和 `test:deploy` 门禁不变。本机 arm64 的结果只作为功能证据，不代表 amd64 生产环境。

#### Scenario: 缺少本机证据不能合并

- **WHEN** 一个修改 `platform/src/ragflow-proxy/` 的 PR 没有对应 head 的本机证据评论
- **THEN** 该 PR 不满足合并条件
