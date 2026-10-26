## ADDED Requirements

### Requirement: 受管覆盖层启用平台入口插件

受管覆盖层 MUST 为每个员工实例插入并启用 `/opt/dsh-team/platform-nav/index.js`，并以 `config.admin` 传入生成覆盖层时该账号是否为管理员；其他受管行及其顺序不变；实例启动后浏览器收到的启动模块清单 MUST 恰好包含该插件。

#### Scenario: 实例加载平台入口插件

- **WHEN** 员工实例按受管覆盖层启动并在真实浏览器中打开工作台
- **THEN** 启动模块清单与预期精确一致且包含 `@dsh-team/platform-nav`，侧栏底部出现平台入口，原有插件和受管设置不变
- **AND** 员工账号的覆盖层 `config.admin` 为 false，管理员账号为 true；直接打开 DSH 的验证通道仍无控制台错误
