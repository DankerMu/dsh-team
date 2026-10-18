## ADDED Requirements

### Requirement: 用户镜像构建源保留 Debian 信任与运行时能力

用户镜像构建 MUST 与验证浏览器镜像复用同一份仅构建期使用的普通 Debian 源切换逻辑，将 bookworm 和 bookworm-updates 的普通源切换到用户批准的清华 Debian 镜像，并保留原有官方安全更新源。修改 MUST 保留 Debian 签名和有效期校验、原有 archive keyring、发行版和组件、包列表、当前基础镜像引用、DSH 版本及现有构建期限；MUST NOT 向运行时注入代理或复制构建辅助程序。全部构建入口 MUST 使用显式、只读、范围限定的辅助构建上下文，不得扩大为仓库根上下文或引入凭据。

#### Scenario: 全部构建入口使用一致策略

- **WHEN** 可信 Docker 测试、交付构建或现有探针构建用户镜像
- **THEN** 相同构建期逻辑只改变普通源，官方安全源和信任配置保持不变，原有精确版本、离线 DOCX、profile/seed、非 root 启动和运行时隔离验收继续成立

#### Scenario: 源布局无有效唯一目标

- **WHEN** 预期的有效普通源行缺失、只有注释或出现多个有效目标
- **THEN** 构建在写入前失败，原有源文件字节保持不变；注释和其他 source/trust 字段不得被误改
