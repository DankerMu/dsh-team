## ADDED Requirements

### Requirement: Office 空闲车道的保活不归因到编辑器

本机全栈 Office 空闲车道的保持断言证明的是：工作台和其中打开的编辑器一起，在空闲分钟数为 1 时保持实例运行。

- 它 MUST NOT 被表述为「编辑器的连接让实例保活」。
- 这是用户接受的残余（#657 C2，2026-11-23）。实测：只开工作台、不开编辑器，同样保持 210 秒，实例仍在运行，没有空闲停止，期间没有 Document Server 连接。
- 工作台自己的连接已经足以保活：两条 WebSocket（`/api/remote.mux`、`/sidebar/ws`）、一条 SSE（`/plugins/events`），以及约每秒一次的 `/sidebar/api` 请求。

#### Scenario: 只开工作台也保持运行

- **WHEN** 空闲分钟数为 1，员工只开着 DSH 工作台，没有打开编辑器，保持 210 秒
- **THEN** 实例保持运行，没有空闲停止审计，所以车道的保持断言不能区分保活来自编辑器还是工作台
