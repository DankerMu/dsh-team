## ADDED Requirements

### Requirement: 平台入口插件随镜像交付

用户镜像 MUST 把仓库插件 `platform-nav` 以 root 所有、只读方式放在 `/opt/dsh-team/platform-nav/`，其声明的 DSH peer 版本 MUST 与镜像内安装的 DSH 版本一致，否则构建失败；所有构建用户镜像的入口 MUST 提供 `platform-nav` 命名构建上下文。

#### Scenario: 插件文件只读且版本匹配

- **WHEN** 检查构建出的用户镜像
- **THEN** `/opt/dsh-team/platform-nav/` 下文件归 root 所有、普通用户不可写，peer 版本等于已安装 DSH 版本；peer 不匹配时镜像构建失败
