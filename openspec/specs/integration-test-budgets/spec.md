# integration-test-budgets Specification

## Purpose

Integration cases wait only inside an explicit case budget. Their synchronous children and asynchronous inner waits are cut from the remaining budget, and an expired wait fails naming its phase and elapsed time, never as a bare runner timeout. Assertions about what was observed synchronize on events, not on wall-clock windows (#656, #687; `constraints.yaml` `testing.integration_deadline_from_case_budget`).

## Requirements

### Requirement: Synchronous child waits fit inside an explicit case budget and fail attributably

The browser-build and CI VPS proxy suites, the profile-seed filesystem-observer cases, and the trusted-Docker audit dispatch case and the five audit cases whose writer runs through the case-budgeted spawn SHALL each declare an explicit case budget instead of inheriting the runner default, and SHALL run their synchronous children bounded by it. Each such child's timeout SHALL be cut from the case's remaining budget at the moment of the spawn, minus a stated reserve, and SHALL be enforced with an uncatchable signal, so that it expires before the case budget. When the cut fires, the failure SHALL name the phase and the elapsed milliseconds, and SHALL report any descendant the suite records that is still alive (or that descendants are not observed), without child output, environment values or paths.

#### Scenario: A synchronous child outlives the case budget

- **WHEN** a covered case's synchronous child would run longer than the case budget allows
- **THEN** the child is killed before the budget expires and the case fails with the phase and the elapsed time, not with a bare runner timeout

### Requirement: Asynchronous inner waits fit inside an explicit case budget and fail attributably

These cases SHALL each declare an explicit case budget:

- every egress-capture case that drives the fake capture;
- the chrome-start receipt-fault case;
- the instance readiness-failure cases;
- the firewall holder script cases;
- the main-process startup cases (`subnet-startup`, `document-server-startup`, `quarantine-bootstrap`).

Every inner wait in them SHALL have a deadline strictly below the case timeout. The deadline is either derived from the case budget, or is a named constant whose relation to the budget is stated.

When an inner wait times out, the failure SHALL name the phase and, except for the holder script, the elapsed milliseconds, and SHALL add per site:

- egress-capture: whether the awaited capture process is alive;
- chrome-start: whether the spawned child is alive;
- instance: the poll count and the observed instance status;
- holder: which phase timed out (`ready` or `exit`); each phase is bounded by its own fixed deadline, so the phase name determines the bound and no elapsed time is reported;
- main-process startup: whether the source process is still present.

A wait made of two phases SHALL give each phase its own deadline.

#### Scenario: An inner wait outlives the case budget

- **WHEN** an egress-capture refusal case's capture never starts listening
- **THEN** the case fails before its budget expires with the phase, the elapsed time and the capture process's liveness, not with a bare runner timeout

#### Scenario: A slow first phase does not starve the second

- **WHEN** the holder script's ready marker arrives late but within its own deadline
- **THEN** the exit wait after SIGTERM still gets its full deadline, and the case reports no timeout

### Requirement: 主表站点在负载下可归因失败，"已观察到"的断言在事件上同步

Docker evidence 门禁、用户卷验收和 `dev:bg` 归属这三组集成用例 MUST 声明显式用例预算，内层期限严格小于预算：

- 同步子进程按剩余预算截断，用不可捕获的信号结束；截断时报出 phase 和耗时，不报 `null` 退出码；
- 用户卷验收的停滞期限只作用于变更请求，读请求和清理共用另一个期限，停滞的 create 仍是唯一的聚合错误；
- `dev:bg` 的归属等待由调用方给出窗口，窗口有写明依据的常量；
- 诱导超时的用例保留调用方给出的窗口作下限，此后等到所需事实都被观察到，或者到达上限；用例预算按账目大于上限加上命令自身退出与清理，到上限仍抛出原有的证据。
- 用户卷验收的看门狗按各用例的最坏路径，由读期限与停滞期限推出，不再是固定值。

#### Scenario: 门禁子进程超过用例预算

- **WHEN** Docker evidence 门禁的子进程运行超过剩余预算
- **THEN** 子进程在预算到期前被杀，用例以 `docker evidence gate: killed at the case deadline after Nms; descendants: not observed` 失败

#### Scenario: 碰撞检查的读请求慢于停滞期限

- **WHEN** 一个碰撞检查 `GET` 慢于停滞期限、快于读期限，随后 create 停滞
- **THEN** 聚合错误只有 create 的取消，碰撞检查不报错

#### Scenario: 负载下 web 构建慢于 5 s 窗口

- **WHEN** 诱导归属超时的用例里，`build:web` 在 5 s 窗口之后才产出 `index.html`
- **THEN** 等待持续到 `lock` 与 `webBuild` 都被观察到（预检失败的用例还要等到命令关闭），再抛出超时证据；held 预检的命令此时仍在运行
