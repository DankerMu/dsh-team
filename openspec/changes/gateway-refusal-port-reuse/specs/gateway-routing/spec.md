## ADDED Requirements

### Requirement: 连接拒绝验证不让测试自有监听占用被释放的端口

验证网关“目标拒绝连接时返回 502、不尝试其他目标、后续解析可恢复”的 HTTP 和 WebSocket 用例，SHALL 在关闭被拒绝的 upstream 之前完成本用例所需的全部监听（健康 upstream 和平台转发应用）。关闭 SHALL 紧接在被拒绝的请求之前进行。用例 SHALL NOT 使用重试、延时或端口预留来规避竞争，原有断言保持不变。

#### Scenario: 被释放端口不会被本用例的后续监听接住

- **WHEN** 拒绝用例关闭 retired upstream 并通过转发应用发出请求
- **THEN** 健康 upstream 和转发应用早已绑定在其他端口，请求得到 502 `Bad Gateway`；切换到健康目标后得到 `healthy`
