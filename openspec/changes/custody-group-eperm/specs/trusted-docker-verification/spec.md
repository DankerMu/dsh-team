## ADDED Requirements

### Requirement: custody fixture 把僵尸进程组的 EPERM 当作正在退出

custody fixture 结算进程组时，MUST 把组信号和组探测返回的 EPERM 当作「组还在、正在退出」，在现有的 `process retirement` 预算内继续等待：

- 完整的 `process retirement` 窗口到期时（cleanup 已预留预算），抛出带 phase、pid 和组状态的 stalled 错误，最后一次 EPERM 作为 `cause`；用例期限先到时，报的是 budget 自己带 phase 的期限错误；
- 其他错误码立即抛出；
- 单进程的 kill 仍然只容忍 ESRCH。

#### Scenario: 组信号返回 EPERM

- **WHEN** 结算一个组，`kill(-pid)` 返回 EPERM，组随后消失
- **THEN** 结算成功，不抛出 `kill EPERM`

#### Scenario: 组探测短暂返回 EPERM

- **WHEN** 组探测先返回几次 EPERM，随后组消失
- **THEN** 结算在预算内成功

#### Scenario: 组探测持续返回 EPERM

- **WHEN** 组探测在完整的 `process retirement` 窗口内都返回 EPERM
- **THEN** 结算以 stalled 错误失败，错误带 phase 和 pid，`cause` 是那次 EPERM

#### Scenario: 组信号或组探测返回其他错误码

- **WHEN** 组信号或组探测返回 EPERM、ESRCH 以外的错误码
- **THEN** 结算立即以该错误失败

#### Scenario: 单进程 kill 返回 EPERM

- **WHEN** 结算单个进程时 kill 返回 EPERM
- **THEN** 结算立即以该 EPERM 失败
