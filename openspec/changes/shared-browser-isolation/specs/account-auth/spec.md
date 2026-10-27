## ADDED Requirements

### Requirement: 切换账号时清理浏览器端状态

登录成功（200）、注册成功（201）或登出成功（204）后，平台页面 MUST 在读完响应体之后、唯一一次导航之前，尽力清理本浏览器在平台 origin 下的状态：

- `localStorage` 和 `sessionStorage`；
- `indexedDB.databases()` 列出的全部数据库；
- 接口存在时，Service Worker 注册和 CacheStorage；
- 脚本可见的 cookie：按当前页面路径及其每一级上级路径（含 `/`）过期。`platform_session` 和无名片段要用全部 cookie 形式写一遍（定义见「自动清除遮蔽平台会话的 cookie」）；其他名称只用主机限定和 `Domain=<当前主机名>` 两种形式，不删除其他内网系统设在共同父域上的 cookie。

清理中任何一步失败，或被另一个标签页阻塞，MUST NOT 阻止或推迟导航，也 MUST NOT 显示错误。HttpOnly 的平台会话 cookie 不受影响。改密码成功后仍保留会话，MUST NOT 清理。

#### Scenario: 不登出直接换人登录

- **WHEN** 员工 A 在浏览器中登录并打开工作台，A 的实例写入了本地存储、会话存储、IndexedDB、CacheStorage 和一个脚本 cookie；A 没有登出，员工 B 在同一浏览器上下文中登录
- **THEN** B 进入工作台时这些存储都为空，没有 IndexedDB 数据库和 CacheStorage 条目，也看不到 A 的脚本 cookie

#### Scenario: 登出时清理

- **WHEN** 员工 A 留下上述状态后，在账号设置页登出
- **THEN** 回到登录页时，这些存储和脚本可见的 cookie 都已清除

#### Scenario: 清理失败不影响进入

- **WHEN** 某个清理接口抛错，或某个 IndexedDB 数据库因其他标签页仍在使用而删除被阻塞
- **THEN** 页面仍只导航一次到原目标，不显示错误

#### Scenario: 接口不存在时跳过

- **WHEN** 浏览器没有 Service Worker、CacheStorage 或 `indexedDB.databases` 接口（例如非本机的纯 HTTP 部署）
- **THEN** 跳过对应步骤，其余步骤照常执行

### Requirement: 自动清除遮蔽平台会话的 cookie

员工实例的脚本可以在更深的路径（如 `/_platform/api`）放置非 HttpOnly 的同名 `platform_session` cookie。平台遇到重名时按无会话处理，这一点 MUST 保持不变。

cookie 形式指以下全部组合：

- 主机限定；
- 主机名为 DNS 名称（不是 IP 字面量）时，再加上主机名及其每一级父域（不含最后一级）的 `Domain=` 形式；
- HTTPS 下，以上每种形式还要各写一个带 `Partitioned; Secure` 的版本。

当一个请求的 `Cookie` 头含有多个 `platform_session` 时，或者登录、注册请求带有任意 `platform_session` 时，平台的回应 MUST 追加过期的 `platform_session` Set-Cookie：

- 路径取请求路径（去掉查询串）的每一级非根上级路径，含请求路径本身，每个路径都带与不带结尾 `/` 两种形式，每种都用全部 cookie 形式发出；
- 主机名为 DNS 名称时，另外对 `Path=/` 发出全部 `Domain=` 形式。

平台 MUST NOT 发出有名称、不分区的主机限定 `Path=/` 过期 cookie，这样合法会话不会被删除。

被拒绝的 WebSocket 升级若带重名会话 cookie，其原始回应 MUST 带同样的过期 Set-Cookie。

自愈逻辑在鉴权之前执行，因此：

- 请求路径（去掉查询串）超过 256 个字符、超过 8 段，或含有 RFC 6265 cookie 路径字符以外的字符（包括 `;`）时，MUST NOT 发出任何过期头；
- 过期头 MUST 按固定优先级发出，且全部 `Set-Cookie` 值的总长度 MUST NOT 超过 3 KiB。优先级依次为：有名主机限定（请求路径的祖先，从最深的开始）、无名主机限定、`Domain` 形式、`Partitioned` 变体。超出预算的部分不发；
- 升级处理中的任何异常 MUST 只销毁该连接，不得使进程退出；
- `Cookie` 头含有不带 `=` 的 `platform_session` 片段（浏览器保存为名称为空的 cookie）时，还 MUST 以同样的路径和形式发出无名过期头 `platform_session; Path=P; Max-Age=0`，并额外包括主机限定的 `Path=/`；
  无名过期头碰不到合法的、有名称的 HttpOnly 会话。

#### Scenario: 换人登录时清除遮蔽 cookie

- **WHEN** 员工 A 未登出，A 的脚本在 `Path=/_platform/api` 放了一个非 HttpOnly 的 `platform_session`；员工 B 在同一浏览器上下文中登录
- **THEN** 登录回应清除该 cookie，B 登录后第一次请求 `/_platform/api/session` 即返回 200 和 B 的邮箱

#### Scenario: 父域和 WebSocket 路径上的遮蔽 cookie

- **WHEN** 以 DNS 主机名部署时，遮蔽 cookie 种在父域上，或者只种在工作台 WebSocket 路径上
- **THEN** 第一个带上它的 HTTP 回应（父域的情形），或第一个被拒绝的升级回应（WebSocket 路径的情形），都带有能清除它的过期 Set-Cookie

#### Scenario: 重名仍按无会话处理

- **WHEN** 一个请求带两个 `platform_session`
- **THEN** 该请求按未登录处理（需要会话的接口返回 401），回应带上述过期 Set-Cookie，不含有名称、不分区的主机限定 `Path=/`；下一次请求不再带遮蔽 cookie

#### Scenario: 超长或带分号的路径不触发自愈

- **WHEN** 一个未认证请求或升级请求带两个 `platform_session`，请求路径为上万个 `/`，或为 `/z/;Path=/`
- **THEN** 回应不带任何过期头，进程继续正常服务

#### Scenario: 无名遮蔽 cookie 被清除

- **WHEN** A 的脚本执行 `document.cookie = 'platform_session; Path=/_platform/api; Max-Age=86400'`，之后 B 登录
- **THEN** B 登录后第一次请求 `/_platform/api/session` 即返回 200
