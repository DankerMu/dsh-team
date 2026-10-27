## ADDED Requirements

### Requirement: 工作台带哈希静态资源长期缓存

平台网关转发工作台响应时，MUST 仅对文件名带内容哈希的 DSH 静态资源（`/assets/` 或其一级小写子目录下的 `<名称>-<8位哈希>.js/css/woff2/woff/ttf`，请求无查询串）在 GET/HEAD 且上游状态200、上游未自带缓存头时加上 `Cache-Control: private, max-age=31536000, immutable`。其他响应 MUST 保持原样转发，上游自带的缓存头 MUST 保留。

#### Scenario: 哈希资源可长期缓存

- **WHEN** 已登录员工经平台网关请求工作台首页引用的 `/assets/index-<哈希>.js`
- **THEN** 响应200并带 `Cache-Control: private, max-age=31536000, immutable`，内容与上游一致

#### Scenario: 其他响应不加缓存

- **WHEN** 请求工作台首页 HTML、`/plugins/events`、带查询串或文件名无哈希的资源，或上游返回非200
- **THEN** 网关不添加缓存头；上游已带的缓存头（如插件合并脚本的 `public, max-age=31536000, immutable`）原样保留
