## ADDED Requirements

### Requirement: 工作台页面资源压缩传输

受管覆盖层 MUST 为每个员工实例开启 DSH 自带 Web 服务的 gzip 压缩（`webserver` 行 `compression: gzip`，等级与阈值沿用 DSH 默认），不修改 DSH 源码。浏览器声明支持 gzip 时，经平台网关取得的工作台脚本 MUST 以 gzip 编码传输且解压后内容与未压缩响应一致；未声明时 MUST 得到未压缩内容。事件流和 WebSocket MUST 不受影响。

#### Scenario: 大脚本压缩传输

- **WHEN** 已登录员工的浏览器带 `Accept-Encoding: gzip` 经平台网关请求工作台首页引用的合并插件脚本
- **THEN** 响应带 `Content-Encoding: gzip`，解压后字节与带 `Accept-Encoding: identity` 请求同一地址得到的未压缩响应完全一致

#### Scenario: 事件流不压缩

- **WHEN** 浏览器经平台网关打开 `/plugins/events`
- **THEN** 响应为 `text/event-stream` 且没有 `Content-Encoding`，首个事件帧可直接解析为模块图
