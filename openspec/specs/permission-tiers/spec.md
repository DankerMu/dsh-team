# permission-tiers Specification

## Purpose

员工可以为每个 Session 选择 Agent 的权限档：人工批准、Auto、Yolo。本规格定义三档各自的可观察行为。

## Requirements

### Requirement: 三档可选并按 Session 切换

每个 Session MUST 可在人工批准、Auto、Yolo 三档之间切换，切换 MUST 只影响当前 Session。

#### Scenario: 切换只影响当前 Session

- **WHEN** 员工把 Session 甲切到人工批准，Session 乙保持 Yolo
- **THEN** 甲里的写操作会先询问，乙里的不询问

#### Scenario: 一个 Session 等待批准时另一个 Session 继续执行

- **WHEN** 人工批准的 Session 甲已有待批准写操作，员工切到同一实例的 Yolo Session 乙并要求写文件
- **THEN** 乙完成写入且整个操作没有询问，甲的文件仍不存在
- **AND** 员工返回甲时仍看到原来的待批准操作；两者档位不变，只有批准甲的操作后甲才写入

### Requirement: 人工批准档

人工批准档下，Agent 每次写文件或执行命令前 MUST 询问员工，员工拒绝则该操作 MUST NOT 执行。

#### Scenario: 批准后执行

- **WHEN** 员工在人工批准档下要求写一个文件并在询问时选择同意
- **THEN** 文件被写入

#### Scenario: 拒绝后不执行

- **WHEN** 员工在询问时选择拒绝
- **THEN** 文件没有被创建，Agent 得知操作被拒绝

#### Scenario: 命令和程序不能绕过人工批准

- **WHEN** 人工批准档调用 bash、执行 run_code 程序或其内层写文件/命令工具
- **THEN** 每次对应的写操作或执行调用在运行前询问，拒绝不产生该调用的副作用
- **AND** 同进程委派不能因子 Agent 的原生 never 策略而变成未询问的完全放行

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

#### Scenario: 无效审查结果和取消不授予权限

- **WHEN** Auto 审查返回不完整、无效或超限结果，或连接失败、超时
- **THEN** 转人工询问；只有员工明确同意才执行
- **AND** 员工取消调用、插件卸载或等待期间切换档位时，旧授权不能让该调用继续执行

### Requirement: 权限执行插件失效关闭

受管三档的执行插件 MUST 随镜像可信交付；缺失、损坏或停止提供门禁时，MUST NOT 让写文件和执行命令绕过档位要求。插件 MUST 保留其他工具门禁的拒绝与取消，MUST NOT 将插件失效解释成切换为 Yolo。

#### Scenario: 权限插件未激活

- **WHEN** 覆盖层指定的权限插件缺失或无法加载
- **THEN** 必需的 Agent 执行服务不能启动，实例不能被当作已就绪
- **AND** 员工可写 profile 下的同名插件副本不能替换可信实现

### Requirement: 任何档位都不能越过实例边界

权限档只决定实例内部的行为；任何档位下 `instance-isolation` 规定的边界 MUST 仍然成立。

#### Scenario: Yolo 档下访问他人实例

- **WHEN** 员工在 Yolo 档下让 Agent 连接另一个用户的实例或读取 Docker socket
- **THEN** 失败

### Requirement: 三档同样约束 continuable 子会话

DSH 0.2.1-rc.2 中所有子 Agent 都是 continuable 子会话。新建的子会话 MUST 在开始第一个回合之前继承父 Session 当时选定的权限档，并按该档执行写文件和执行命令，效果与根 Session 相同。子会话的批准请求 MUST 归属子会话本身，员工在子会话中作答。子会话被恢复或收到后续消息时，MUST 沿用它自己记录的档位，不重新继承父 Session 当前的档位。

#### Scenario: 人工批准档下子会话的拒绝

- **WHEN** 父 Session 为人工批准档，其子会话请求写一个文件，员工在子会话中选择拒绝
- **THEN** 文件没有被创建，子会话得知操作被拒绝，父 Session 没有出现该批准请求

#### Scenario: 人工批准档下子会话的允许

- **WHEN** 父 Session 为人工批准档，其子会话请求写一个文件，员工在子会话中选择允许一次
- **THEN** 文件被写入且内容与请求一致，该调用只执行一次

#### Scenario: 等待批准时取消

- **WHEN** 子会话的写文件请求正在等待批准，员工停止该子会话当前的任务（continuable 子会话拥有自己的回合，不随父 Session 的取消而中止）
- **THEN** 批准请求撤回，文件没有被创建，之后的批准不能让该调用继续执行

#### Scenario: Yolo 和 Auto 档下的子会话

- **WHEN** 父 Session 分别为 Yolo 档和 Auto 档（审查可用且放行），其子会话请求在工作目录写一个普通文件
- **THEN** 两种情况下文件都被写入且没有询问员工；Auto 档下该操作经过了模型审查

#### Scenario: 恢复的子会话保持自己的档位

- **WHEN** 子会话在人工批准档下完成回合，父 Session 随后切到 Yolo，员工再给该子会话发送一条要求写文件的后续消息
- **THEN** 子会话仍按人工批准档询问员工

### Requirement: 权限档行为在 DSH 0.2.1-rc.2 上保持

DSH 升级到 0.2.1-rc.2 后，本能力既有的行为 MUST 保持不变，包括三档切换、人工批准、Yolo、Auto 及其退为询问、插件失效关闭和实例边界；真实 DSH 浏览器用例 MUST 对根 Session 和子会话都覆盖拒绝、允许、取消三条路径。

#### Scenario: 升级后全量重跑

- **WHEN** 对 DSH 升级的精确提交执行完整的 `pnpm test:docker`
- **THEN** 本能力的既有验收和子会话的三条路径全部通过，没有被跳过或放宽的用例
