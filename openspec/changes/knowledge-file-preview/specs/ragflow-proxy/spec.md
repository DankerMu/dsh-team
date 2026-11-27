## RENAMED Requirements

- FROM: `### Requirement: 只有四个只读接口`
- TO: `### Requirement: 只有五个只读接口`

## MODIFIED Requirements

### Requirement: 只有五个只读接口

平台 SHALL 在实例专用前缀 `/_platform/instance-api/ragflow/` 下为员工实例提供且只提供五个 RAGFlow 只读接口：`GET datasets`（知识库列表）、`GET datasets/{id}/documents`（库内文件列表）、`GET datasets/{id}/documents/{documentId}/chunks`（文件解析后内容的只读预览，2026-11-27 项目方决定新增）、`POST retrieval`（限定范围的检索）、`GET version`（版本查询）。平台 MUST NOT 提供任何写 RAGFlow 的接口，MUST NOT 做通用转发，MUST NOT 返回原件；该前缀下未声明的路径和方法 MUST 返回 404 或 405，且不会向 RAGFlow 发出请求。每个接口 MUST 声明请求和响应 schema，并出现在生成的 HTTP 契约中。

该前缀位于网关保留的 `/_platform` 路径下：网关 MUST NOT 要求平台会话，也 MUST NOT 把它转发给 DSH。它不在 `/_platform/api/` 下，平台变更接口的 Origin/JSON 守卫不适用，由实例令牌鉴权代替；检索 POST MUST 自己要求 `application/json` 请求体。

#### Scenario: 只读接口可用

- **WHEN** 运行中的实例带有效实例令牌，分别请求知识库列表、某库的文件列表、某文件的内容预览、检索和版本查询
- **THEN** 平台分别返回对应的规范化结果，结果中不含 RAGFlow 地址和密钥

#### Scenario: 前缀不经平台会话也不转发给 DSH

- **WHEN** 一个不带平台会话、带有效实例令牌的请求到达 `/_platform/instance-api/ragflow/version`
- **THEN** 网关不把它重定向到登录页、不转发给任何 DSH 实例，由代理处理并返回版本结果

#### Scenario: 检索要求 JSON

- **WHEN** 带有效令牌的检索 POST 使用非 JSON 的内容类型
- **THEN** 平台返回 415，不访问 RAGFlow

#### Scenario: 不存在写接口和通用转发

- **WHEN** 实例带有效令牌，对代理前缀发出 POST/PUT/DELETE 到非检索路径，或请求未声明的路径
- **THEN** 平台返回 404 或 405，RAGFlow 侧没有收到任何请求

#### Scenario: 内容预览只返回所请求文件的分块文本

- **WHEN** 实例请求库 A 中文件 D 的内容预览，而 RAGFlow 返回的文件不是 D，或返回的文件不属于库 A
- **THEN** 平台返回 `upstream-error`，不返回任何分块内容
