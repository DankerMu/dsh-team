# permission-tiers

## Purpose

员工可以为每个 Session 选择 Agent 的权限档：人工批准、Auto、Yolo。本规格定义三档各自的可观察行为。

## ADDED Requirements

### Requirement: 三档可选并按 Session 切换

每个 Session MUST 可在人工批准、Auto、Yolo 三档之间切换，切换 MUST 只影响当前 Session。

#### Scenario: 切换只影响当前 Session

- **WHEN** 员工把 Session 甲切到人工批准，Session 乙保持 Yolo
- **THEN** 甲里的写操作会先询问，乙里的不询问

### Requirement: 人工批准档

人工批准档下，Agent 每次写文件或执行命令前 MUST 询问员工，员工拒绝则该操作 MUST NOT 执行。

#### Scenario: 批准后执行

- **WHEN** 员工在人工批准档下要求写一个文件并在询问时选择同意
- **THEN** 文件被写入

#### Scenario: 拒绝后不执行

- **WHEN** 员工在询问时选择拒绝
- **THEN** 文件没有被创建，Agent 得知操作被拒绝

### Requirement: Yolo 档

Yolo 档下，Agent 写文件和执行命令 MUST NOT 询问员工。

#### Scenario: 不询问直接完成

- **WHEN** 员工在 Yolo 档下要求写一个文件
- **THEN** 文件被写入，过程中没有出现询问

### Requirement: Auto 档

Auto 档下，写文件和执行命令 MUST 先经模型审查，审查放行的操作 MUST NOT 询问员工。Auto 审查不可用时，该档 MUST 按人工批准档的方式询问员工，MUST NOT 直接放行。

#### Scenario: 审查放行

- **WHEN** 员工在 Auto 档下要求在工作目录写一个普通文件，审查可用
- **THEN** 文件被写入，没有询问员工

#### Scenario: 审查不可用时退为询问

- **WHEN** Auto 审查在当前模型上不可用，员工在 Auto 档下要求写一个文件
- **THEN** 员工被询问是否同意，同意后才写入

### Requirement: 任何档位都不能越过实例边界

权限档只决定实例内部的行为；任何档位下 `instance-isolation` 规定的边界 MUST 仍然成立。

#### Scenario: Yolo 档下访问他人实例

- **WHEN** 员工在 Yolo 档下让 Agent 连接另一个用户的实例或读取 Docker socket
- **THEN** 失败
