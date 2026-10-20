# Spec Delta

## ADDED Requirements

### Requirement: 用户镜像基础层身份固定且经审查更新

生产用户镜像 MUST 使用可读的精确 Node24补丁版本/Bookworm-slim标签与不可变基础镜像摘要；摘要 MUST 支持现有Linux amd64构建目标。基础层更新 MUST 通过显式审查，核对官方tag/index/platform/config身份并重新执行精确提交的原始完整Docker验收；MUST NOT 仅随major标签移动或以较窄smoke替代完整验收。仅固定基础身份不得声称动态apt/npm依赖也已完全可复现；其他镜像和历史phase0证据不随本要求自动迁移。

#### Scenario: 上游可变标签随后变化

- **WHEN** 上游修改原有major或patch标签指向，但仓库中的已审查摘要未改变
- **THEN** 用户镜像继续选择同一不可变基础身份，不静默改用标签的新目标

#### Scenario: 经审查更新基础层

- **WHEN** 维护者提交新的精确版本及摘要
- **THEN** 官方元数据和内容摘要核验支持目标架构，实际构建出的镜像证明Node24/Bookworm及原非root/DSH能力，原始完整Docker验收和独立清理通过后才交付
- **AND** DSH/pnpm pin、其他Dockerfile行为、其他镜像及所有既有gate保持不变
