## ADDED Requirements

### Requirement: Document Server 防火墙持有者重启的验证

部署验证 MUST 覆盖 Document Server 防火墙持有者的重启：持有者单独重启后，Document Server 留在旧命名空间、实例访问不到它，而新命名空间重新装上入站规则；`docker compose up -d` 不改变这一状态；按运维手册重启 Document Server 后，它回到持有者的新命名空间，实例只能访问其 80 端口。持有者的 IPv6 入站规则 MUST 在真实内核上读回，并与脚本安装的规则逐条一致。

#### Scenario: 持有者重启与手册恢复

- **WHEN** 部署验证依次重启持有者、执行一次 `docker compose up -d`、再重启 Document Server
- **THEN** 持有者重启后，持有者 ID 和 Document Server 的网络归属不变，但持有者命名空间内 80 与 8000 都无人监听，实例对持有者 80 端口的连接被拒绝、对 8000 端口超时；`up -d` 之后各容器 ID 与启动时间不变、状态不变；Document Server 重启后，实例访问 80 有应答、8000 超时

#### Scenario: IPv6 规则读回

- **WHEN** 部署验证在持有者内读取 IPv6 入站规则
- **THEN** 持有者具备 IPv6，默认策略是 DROP，且恰好包含回环、已建立连接、TCP 80 和 ICMPv6 四条放行规则；持有者重启后的新命名空间同样如此
