## ADDED Requirements

### Requirement: 自带 Document Server 报告启动完成

交付的 Compose 定义 MUST 为自带 Document Server 提供健康检查：只有当镜像启动脚本的最后一步（`xargs tail -F`）已经在运行时才报告 `healthy`，因此报告 `healthy` 之后不会再出现这次启动引起的 docservice 重启。探测 MUST NOT 匹配到探测进程自身，并且在真实镜像和部署验证替身里按同一定义生效；替身 MUST 通过运行同形的最后一步达到 `healthy`，不得覆盖或关闭健康检查。部署文档 MUST 说明这个窗口的成因、会触发它的运维操作，以及在通知员工使用 Office 之前如何等待 `healthy`。

#### Scenario: 启动窗口内不报告健康

- **WHEN** 自带 Document Server 容器刚启动，nginx 已在服务，但启动脚本尚未跑到最后一步
- **THEN** 容器健康状态不是 `healthy`；最后一步出现后才变为 `healthy`，之后 docservice 不再被这次启动重启

#### Scenario: 部署验证替身按同一定义变为健康

- **WHEN** 部署验证用替身替换 Document Server 镜像
- **THEN** 替身继承交付的健康检查定义，并在启动期限内达到 `healthy`
