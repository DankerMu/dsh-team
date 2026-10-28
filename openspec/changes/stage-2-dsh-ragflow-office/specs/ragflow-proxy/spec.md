## Purpose

平台的 RAGFlow 只读代理：凭实例令牌识别员工实例，只开放四个只读接口，在平台侧应用管理员的连接设置和检索参数，并把 RAGFlow 的业务错误映射为封闭的错误集合。RAGFlow 密钥只留在平台。

## ADDED Requirements

### Requirement: 只有四个只读接口

平台 SHALL 在实例专用前缀 `/_platform/instance-api/ragflow/` 下为员工实例提供且只提供四个 RAGFlow 只读接口：`GET datasets`（知识库列表）、`GET datasets/{id}/documents`（库内文件列表）、`POST retrieval`（限定范围的检索）、`GET version`（版本查询）。平台 MUST NOT 提供任何写 RAGFlow 的接口，MUST NOT 做通用转发；该前缀下未声明的路径和方法 MUST 返回 404 或 405，且不会向 RAGFlow 发出请求。每个接口 MUST 声明请求和响应 schema，并出现在生成的 HTTP 契约中。

该前缀位于网关保留的 `/_platform` 路径下：网关 MUST NOT 要求平台会话，也 MUST NOT 把它转发给 DSH。它不在 `/_platform/api/` 下，平台变更接口的 Origin/JSON 守卫不适用，由实例令牌鉴权代替；检索 POST MUST 自己要求 `application/json` 请求体。

#### Scenario: 只读接口可用

- **WHEN** 运行中的实例带有效实例令牌，分别请求知识库列表、某库的文件列表、检索和版本查询
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

### Requirement: 实例令牌鉴权

代理接口 MUST 只接受 `Authorization: Bearer <实例令牌>`，MUST NOT 接受平台会话 cookie。平台 MUST 用令牌找到状态为运行中、且令牌属于当前这次启动的实例，并核对请求来源 IP 等于该实例的固定地址。令牌缺失、格式错误、已停止实例的令牌、上一次启动的令牌、来源 IP 不符，MUST 一律返回不区分原因的 401，并且不访问 RAGFlow。没有令牌的 POST（无论是否带 Origin）同样返回 401。令牌明文 MUST NOT 被持久化、记录日志或出现在任何响应中。

#### Scenario: 有效令牌从本实例地址访问

- **WHEN** 实例 A 用本次启动注入的令牌、从 A 的固定 IP 请求知识库列表
- **THEN** 平台按 A 所属用户处理请求并返回 200

#### Scenario: 平台会话不能访问代理

- **WHEN** 浏览器只带有效的 `platform_session` cookie 请求代理接口
- **THEN** 平台返回 401，RAGFlow 侧没有收到请求

#### Scenario: 无令牌的 POST 被拒

- **WHEN** 一个不带 `Authorization` 也不带 Origin 的请求 POST 到检索接口
- **THEN** 平台返回 401，RAGFlow 侧没有收到请求

#### Scenario: 旧令牌和他人地址被拒

- **WHEN** 实例 A 重启后仍使用上一次的令牌，或实例 B 从 B 的 IP 使用 A 的令牌
- **THEN** 两种请求都得到相同的 401 响应，响应和日志中都不出现令牌

### Requirement: 连接设置和检索参数在平台侧应用且保存即生效

代理每次处理请求时 MUST 读取最新保存的 RAGFlow 地址、密钥和检索参数（top_k、相似度阈值、关键词权重、rerank 选择），不缓存。检索参数 MUST 只由平台在调用 RAGFlow 时加入；实例请求中携带的任何检索参数字段 MUST 被拒绝为 `invalid-request`，不访问 RAGFlow。RAGFlow 未配置时，代理接口 MUST 返回 `not-configured` 且不发出外部请求。

#### Scenario: 管理员改参数后下一次检索立即使用新值

- **WHEN** 管理员把 top_k 从 8 改为 3 并保存，之后实例发起一次检索
- **THEN** 平台发给 RAGFlow 的检索请求使用 top_k=3，无需重启实例

#### Scenario: 实例不能自带检索参数

- **WHEN** 实例的检索请求体包含 `top_k` 或 `similarity_threshold` 字段
- **THEN** 平台返回 `invalid-request`，不访问 RAGFlow

#### Scenario: 未配置时明确报错

- **WHEN** 管理员尚未保存 RAGFlow 地址和密钥，实例请求知识库列表
- **THEN** 平台返回 `not-configured`，不发出任何外部请求

### Requirement: 检索范围预检且从不退回全库

检索请求 MUST 携带非空的知识库 ID 集合。平台 MUST 先获取当前存在的知识库列表，剔除已不存在的 ID，并在结果中返回被剔除的 ID。剔除后为空时 MUST 不向 RAGFlow 发送检索请求，并返回空范围结果。任何情况下平台 MUST NOT 以空集合或省略范围的方式调用 RAGFlow 检索，即从不退回全库。

#### Scenario: 剔除不存在的库后检索

- **WHEN** 请求范围是 {库1, 已删除的库2}
- **THEN** 平台只用 {库1} 检索，并在结果中标明库2 已被剔除

#### Scenario: 全部失效时不检索

- **WHEN** 请求范围中的库都已不存在
- **THEN** 平台不调用 RAGFlow 检索接口，返回空范围结果并列出全部被剔除的 ID

#### Scenario: 空范围被拒

- **WHEN** 检索请求的知识库 ID 集合为空
- **THEN** 平台返回 `invalid-request`，不调用 RAGFlow

### Requirement: 返回片段越界校验

平台 MUST 校验每个返回片段的所属知识库都在本次实际检索的集合内。只要有一个片段越界，整次检索 MUST 以 `upstream-error` 失败，且不返回任何片段。

#### Scenario: 越界片段导致整体失败

- **WHEN** RAGFlow 返回的片段中有一个 `dataset_id` 不在请求集合内
- **THEN** 平台返回 `upstream-error`，响应中没有任何片段内容

### Requirement: 业务错误按响应体判断并映射为封闭集合

平台 MUST 依据 RAGFlow 响应体的 `code` 判断成败，不能只看 HTTP 状态。结果取值是唯一的封闭集合，代理、插件和测试都只用这一套。检索成功但没有片段 MUST 表示为 `no-results`，不算错误。所有失败 MUST 映射为下面之一：

- `invalid-request`：请求不合法（空范围、自带检索参数、字段错误）；
- `not-configured`：RAGFlow 未配置，或地址、密钥被拒（配置错误）；
- `timeout`：超时；
- `unavailable`：连接失败（服务中断）；
- `upstream-error`：其他非零 `code`、越界片段或响应不可解析（服务异常）。

外部请求 MUST 有固定超时、不跟随重定向、限制响应体大小，并且不重试。错误响应 MUST NOT 包含上游原始消息、地址或密钥。

#### Scenario: HTTP 200 但 code 非零

- **WHEN** RAGFlow 以 HTTP 200 返回 `code:102`
- **THEN** 平台返回 `upstream-error`（或密钥被拒时的 `not-configured`），不当作成功

#### Scenario: 超时与中断可区分

- **WHEN** RAGFlow 在超时时间内没有响应；或者连接被拒绝
- **THEN** 前者返回 `timeout`，后者返回 `unavailable`，两者都不含上游细节

#### Scenario: 无结果不是错误

- **WHEN** 检索成功且 RAGFlow 返回零个片段
- **THEN** 平台返回成功的空结果，取值为 `no-results`

### Requirement: 结果字段只含真实值

检索结果的每个片段 MUST 包含片段文本、文件名和所属知识库名称。页码和位置字段 MUST 只在 RAGFlow 有值时出现，平台 MUST NOT 伪造。

#### Scenario: 没有页码就不显示页码

- **WHEN** RAGFlow 返回的片段没有页码和位置信息
- **THEN** 平台结果中该片段没有页码和位置字段，而不是填 0 或空字符串

### Requirement: RAGFlow 不可用不影响平台其他功能

RAGFlow 不可达、超时或返回错误时，登录、实例启动、网关转发和后台其他页面 MUST 照常工作；实例启动 MUST NOT 依赖 RAGFlow 可用。

#### Scenario: RAGFlow 停机时仍能进入工作台

- **WHEN** RAGFlow 服务停止，员工登录并进入工作台
- **THEN** 实例正常启动并可用，只有知识库相关请求返回 `unavailable`
