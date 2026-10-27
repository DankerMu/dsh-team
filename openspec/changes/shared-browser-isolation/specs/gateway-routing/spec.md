## MODIFIED Requirements

### Requirement: 工作台带哈希静态资源长期缓存

平台网关转发工作台响应时，MUST 仅对文件名带内容哈希的 DSH 静态资源（`/assets/` 或其一级小写子目录下的 `<名称>-<8位哈希>.js/css/woff2/woff/ttf`，请求无查询串）在 GET/HEAD 且上游状态200、上游未自带缓存头时加上 `Cache-Control: private, max-age=31536000, immutable`。其他响应 MUST 保持原样转发，上游自带的缓存头 MUST 保留；唯一例外是「工作台缓存按平台会话区分」要求的 `Vary` 合并。

#### Scenario: 哈希资源可长期缓存

- **WHEN** 已登录员工经平台网关请求工作台首页引用的 `/assets/index-<哈希>.js`
- **THEN** 响应200并带 `Cache-Control: private, max-age=31536000, immutable`，内容与上游一致

#### Scenario: 其他响应不加缓存

- **WHEN** 请求工作台首页 HTML、`/plugins/events`、带查询串或文件名无哈希的资源，或上游返回非200
- **THEN** 网关不添加缓存头；上游已带的缓存头（如插件合并脚本的 `public, max-age=31536000, immutable`）原样保留

#### Scenario: 长期缓存只在同一会话内有效

- **WHEN** 哈希资源带着网关加的长期缓存头返回
- **THEN** 同一响应的 `Vary` 也含 `Cookie`，换一个平台会话请求同一地址不会命中这份缓存

## ADDED Requirements

### Requirement: 工作台缓存按平台会话区分

员工能完全控制自己实例返回的路径、内容和缓存头，所有实例又共用平台这一个浏览器 origin。因此平台网关 MUST 在每个转发的工作台 HTTP 响应上把 `Cookie` 和 `Service-Worker` 合并进 `Vary`，不论状态码、内容类型和上游缓存头：

- 上游没有 `Vary` 时，设为 `Cookie, Service-Worker`；
- 已有 `Vary` 时，保留原值，并按这个顺序追加其中缺少的 token（大小写不敏感）；
- 含 `*` 时，原样保留。

WebSocket 升级、`/_platform` 下的平台响应，以及网关自己生成的跳转和 503，MUST NOT 因此改变。

#### Scenario: 上一位用户的长期缓存不会给下一位用户

- **WHEN** 员工 A 的实例为某个工作台地址返回带 `immutable` 长期缓存的脚本，之后员工 B 在同一浏览器中登录并请求同一地址
- **THEN** B 的请求到达 B 自己的实例，B 拿到的是 B 实例的内容，而不是 A 留在缓存里的内容

#### Scenario: 合并而不覆盖上游的 Vary

- **WHEN** 上游响应没有 `Vary`，或分别带 `Vary: Accept-Encoding`、`Vary: cookie`、`Vary: *`
- **THEN** 浏览器收到的 `Vary` 依次是 `Cookie, Service-Worker`、`Accept-Encoding, Cookie, Service-Worker`、`cookie, Service-Worker`、`*`；状态、其他响应头和内容不变

#### Scenario: 真实 DSH 响应带会话区分

- **WHEN** 在真实部署中经网关请求原生工作台 HTML、首页引用的哈希入口脚本、插件合并脚本和事件流
- **THEN** 每个响应的 `Vary` 都恰好含一个 `Cookie` 和一个 `Service-Worker`

### Requirement: 实例不能经网关注册 Service Worker

平台网关 MUST NOT 转发带 `Service-Worker` 请求头的请求，MUST 以不含细节的 403 JSON 回应。这样员工实例无法在平台 origin 下注册 Service Worker，也无法更新已注册的 Service Worker。不带该请求头的请求按原样转发。

#### Scenario: 注册被拒绝

- **WHEN** 已登录员工的工作台页面调用 `navigator.serviceWorker.register` 注册其实例提供的脚本
- **THEN** 浏览器的脚本请求得到 403，请求没有到达实例，注册失败，该 origin 下没有新的 Service Worker

#### Scenario: 预热缓存不能绕过

- **WHEN** 页面先用普通 `fetch` 取过该脚本，再以 `updateViaCache: 'all'` 注册
- **THEN** 注册仍然失败，因为不带 `Service-Worker` 头缓存的条目不能用于注册请求
