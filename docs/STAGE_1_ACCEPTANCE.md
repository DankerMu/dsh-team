# 阶段 1 验收对照

## 范围与结论

本页是任务19.8的证据索引，不重新定义需求。权威顺序为[需求基线](REQUIREMENTS_BASELINE.md)第7节、[原任务书](DSH_Enterprise_Requirements_Standalone.md)第十五节、[实施计划](IMPLEMENTATION_PLAN.md)阶段1完成条件；部署步骤见[DEPLOY](DEPLOY.md)。

阶段1范围：验收1、2、13；验收3仅“不配置个人模型密钥即可完成真实工具调用”；验收12仅“停止或重建后恢复文件与Session”及已验证的故障边界。Office、离线交付、生产模型复验和目标机容量不在本阶段完成声明内。

**当前状态：功能证据已形成，阶段最终验收尚未签结。** 下表区分每次实测SHA，不把旧模型运行冒充当前头运行。关键路径人工白盒审查仍按项目方决定后置，尚未通过；#226等残余风险未被后续绿色运行解释或修复。

## 证据批次

| 编号 | 命令 / 环境 | 已观察结果 | 绑定版本与公开证据 |
| --- | --- | --- | --- |
| C | `pnpm check`，macOS arm64 / Node24.13.1 | 2216单元、1185集成通过；lint/types/build/contract/anti-drift通过，重复行2.82% | #104审查头 `a80f1b5f91f94ca8e1bdef556b7e1d1cc83ed857`；[运行说明](https://github.com/DankerMu/dsh-team/pull/251#issuecomment-6206872665)、[CI38837044495](https://github.com/DankerMu/dsh-team/actions/runs/38837044495) |
| D | 原始 `pnpm test:deploy`，giap-vps Linux amd64 | 11/11，384.41s，exit0 | 同一 `a80f1b5`；[精确头证据](https://github.com/DankerMu/dsh-team/pull/251#issuecomment-6206872665) |
| K | 原始完整 `pnpm test:docker`，giap-vps Linux amd64 | 30文件89/89，976.16s，exit0；包含部署11项 | 同一 `a80f1b5`；原始日志 `.run/issue104/reviewed-docker.log`，归档SHA256 `377ef8b9f0a9b55e397084e12f0c13a53770235ef95e5debf0ad72fc8881e6a8` |
| U | 原始 `pnpm test:ui`，真实构建React / Playwright Chromium153.0.8010.12 | 41/41，截图已检查，无未预期console/page/request/external错误 | #75审查头 `78932eb9a29fe0a775fe7a17f202cd36b99c4741`；[证据](https://github.com/DankerMu/dsh-team/pull/249#issuecomment-6202712145)；C对应CI也重新执行UI成功 |
| M | 受信Actions实际 `pnpm test:model`，giap-vps、真实开发模型 | 2/2，234.50s；原模型案例183.971s，Yolo隔离49.276s | #102审查头 `f8086299f00b634755f0011271c3f320c28df139`；[Actions38741643901](https://github.com/DankerMu/dsh-team/actions/runs/38741643901)、[说明](https://github.com/DankerMu/dsh-team/pull/241#issuecomment-6194325462)；**历史成功，不是当前头模型复验** |
| M2 | 用户新授权的一次完整 `pnpm test:model`，受限Actions→giap-vps | **1/2通过，369.62s，exit1**；managed-model239.575s通过，Yolo第二探针被`permission-intended-bash`拒绝 | #105候选 `8b6eb167a15b0f2f778d079a95441781857ca05b`；[Actions38843236093](https://github.com/DankerMu/dsh-team/actions/runs/38843236093)、[失败及独立清理记录](https://github.com/DankerMu/dsh-team/pull/253#issuecomment-6207212224)；单次授权已耗尽，禁止自动重试 |
| D2/K2 | #105候选原始deploy及完整Docker，giap-vps | deploy11/11，380.36s；Docker30文件89/89，965.44s；LinuxHTTP25/25；全部exit0且独立库存/unit为空 | 与M2相同 `8b6eb167`；[精确头非模型证据](https://github.com/DankerMu/dsh-team/pull/253#issuecomment-6207477827)；不清除独立模型失败 |
| D3/K3 | #254诊断修复，原始deploy及完整Docker，giap-vps | deploy11/11，377.12s；Docker30文件89/89，958.67s；Linux oracle66/66；全部exit0且独立库存/unit为空 | 审查头 `cb7f05ec46616eed46057f9777b96c264447bfd6`；[精确头证据](https://github.com/DankerMu/dsh-team/pull/255#issuecomment-6208964123)、[CI38853620017](https://github.com/DankerMu/dsh-team/actions/runs/38853620017)；PR255已合并为409b6b2，无外部模型调用 |

D/K均由父级在四席审查后从精确Git归档执行，Node24.13.1、pnpm10.34.6、Docker29.1.3；前后独立自有容器、卷、网络、测试镜像库存及活动unit为空。M的一次性临时GitHub凭据、SSH能力、工作目录、锁、Docker资源与unit也独立确认退休。测试替身不会计入M。

M2是最近一次模型复验，整体失败，不能被M的旧成功覆盖。复合oracle失败码没有各子条件的单独事实，暂不能归因为命令改写、工具名、调用身份或时序；[#254](https://github.com/DankerMu/dsh-team/issues/254)跟踪诊断。原用例通过、截图已检查且浏览器health错误0；operator和host退休成功，父级独立确认临时secret/SSH能力/私有工作目录/锁/四类资源及活动unit均不存在。#105与阶段签结仍阻塞，不降低判据。

D3/K3是最近的部署/Docker批次，下列所有D/K测试在这次原始完整发现中也通过；表内单项耗时保留为K批次的可追溯历史值，不混用为K3测量。没有将部署绿色替代模型失败。PR255仅补充五个固定布尔诊断，保留原完全相等/身份/时序判据；非模型真实原生命令资格验证通过，但不能恢复M2未保留的历史子条件，也不是新模型验收。

## 逐条验收映射

以下测试名为仓库实际名称；批次字母指向上表的命令、SHA与最近已观察结果。同一Docker测试也可能被deploy入口选择，不能将两次运行或同一断言重复计算为不同功能。

### 验收1：两个账号使用不同实例与私有存储

| 测试文件 / 测试名 | 证明与最近结果 |
| --- | --- |
| `platform/test/deployment.docker.test.ts` — `preserves accounts, settings, audit and two unrestarted native instances across platform recreation` | 两个真实员工不同实例、原生Session与持久卷；只重建平台后员工容器身份/启动时间/挂载不变，原账号重新登录可读取各自Session。D/K通过；K单项22.494s。 |
| `platform/test/deployment.docker.test.ts` — `keeps hostile employee HTTP requests inside their own native instance and rejects administrator access` | A/B文件和Session身份交叉请求被隔离；B自己的正向读取仍有效。D/K通过；K单项21.267s。 |
| `platform/test/first-use.docker.test.ts` — `gives untouched employees automatic work Sessions and preserves employee state on volume reuse` | 新员工真实浏览器直接进入工作区、第二员工隔离、重建复用卷保留员工数据；截图与浏览器错误检查。K通过，21.346s。 |

### 验收2：API、长连接、路径、插件、Shell与网络越界被阻止

| 测试文件 / 测试名 | 证明与最近结果 |
| --- | --- |
| `platform/test/deployment.docker.test.ts` — `keeps hostile employee HTTP requests inside their own native instance and rejects administrator access` | 外部HTTP、伪造用户/Session标识与转发头不能进入他人实例；员工管理API403。D/K通过。 |
| 同文件 — `rejects another employee Session over native logical streams while preserving own live delivery` | 原生逻辑流拒绝他人Session，同时自己的载体/事件继续；不是只检查WebSocket握手。D/K通过；K单项20.927s。 |
| 同文件 — `denies internal employee access to sibling volumes, listening ports, Docker and platform authority` | 真实uid1001内部探针覆盖兄弟home/work、3080/3099地址与别名、Docker socket、管理权限、只读受管覆盖层，含活的正向对照和不变哨兵。D/K通过；K单项23.682s。 |
| 同文件 — `rejects sibling native credentials and keeps platform data outside employee files and environments` | 各自原生cookie/token正向有效，跨实例401；平台数据库与凭据扫描限于该员工可读视图，不声称任意编码/内存保密。D/K通过；K单项31.493s。 |
| `platform/test/deployment-isolation.model.test.ts` — `keeps all five deployed isolation boundaries when the real B Agent executes the canonical probes in Yolo` | 真正B Agent以Yolo执行同一五边界矩阵，原生调用/结果及A后状态关联，不靠模型口头总结。M历史通过49.276s；最近M2失败128.856s，第二探针被oracle拒绝，本项最终复验未通过。 |

此隔离不等于默认阻断实例访问整个内网，也不提供共用模型密钥对员工的保密隔离；这两项是已记录的产品边界，不是遗漏的通过项。DSH源码未修改；插件受管策略及真实执行入口的证明另见K中的权限/办公委派测试。

### 验收3（本阶段）：员工不配置个人密钥即可真实调用工具

| 测试文件 / 测试名 | 证明与最近结果 |
| --- | --- |
| `platform/test/managed-model.model.test.ts` — `lets a fresh employee use the administrator model to create exact workspace bytes without personal model settings` | 管理员HTTP保存模型配置、新员工真实登录与原生任务；文件事前不存在、模型工具实际生成精确字节。还包含手动writer与自然语言委派DOCX、原生子Session构造结果与最终五字段解析。最近M2单项通过239.575s；不是测试预写文件、模拟provider或完成文本证明；不代表整体模型套件通过。 |

开发模型与生产`qwen3.6`的复验、无公网任务交付按基线留阶段3。M2使用新明确授权的一次完整执行，授权已耗尽；后续模型调用必须再次明确授权并通过受限Actions通道执行，不能自动重试或将历史M绑定为新头。

### 验收12（本阶段）：停止或重建后恢复文件与Session

| 测试文件 / 测试名 | 证明与最近结果 |
| --- | --- |
| `platform/test/instance-idle.docker.test.ts` — `the same platform session resumes a retired instance with its completed conversation and exact work bytes` | 同一平台会话显式启动，新物理容器复用两卷，原Session/完整历史/中文与二进制工作字节保留。K通过，9.823s。 |
| `platform/test/admin-instance-restart.docker.test.ts` — `admin HTTP restart updates physical StartedAt, reaches ready and preserves genuine Session/history, files, volumes, platform sessions and sibling connection` | 管理员实际重启，物理启动身份改变、目标连接关闭、兄弟连接及内容不变。K通过，13.038s。 |
| 同文件 — `administrator reset repairs a genuinely broken profile then explicit startup preserves native Session history, files and sibling` | 损坏配置导致真实失败，reset204后仍停止，显式启动恢复原Session与文件；没有自动启动或删除内容。K通过，13.350s。 |
| `platform/test/container-stop.docker.test.ts` — `preserves exact uid1001 state and workspace files across production stop/delete/recreate while leaving a sibling unchanged` | 真实停止/删除/重建后的两卷精确字节及兄弟不变。K通过，6.945s。 |
| `platform/test/deployment.docker.test.ts` — `preserves accounts, settings, audit and two unrestarted native instances across platform recreation` | 平台容器重建不替换员工容器，持久账号/设置/审计与原生Session保持。D/K通过。 |

Office活动保活与共同编辑不在阶段1；运行中任务断点续跑亦不是已交付保证。异常与共享资源风险列于下节，不以当前成功覆盖历史未知。

### 验收13：失效策略、故障排查、浏览器与日志凭据边界

| 测试文件 / 测试名 | 证明与最近结果 |
| --- | --- |
| `platform/test/admin-account-status.docker.test.ts` — `disable closes both real DSH sessions and physically retires within five seconds; enable preserves conversation, volumes and sibling` | 禁用撤销平台会话、关闭真实载体并在5秒内退休，重新启用保留内容与兄弟；操作前活性及相对关闭时序已验证。K通过，12.854s。 |
| `platform/test/admin-config-activation.docker.test.ts` — `keeps the running model selector unchanged after save and activates the new exact list and default on administrator restart` | 保存不偷偷改变运行中实例；明确重启后才应用精确新列表/默认，符合已定生效策略。K通过，21.737s。 |
| 同文件 — `lets the same real held Agent turn finish after model configuration is saved` | 配置保存不打断同一实际在途任务。K通过，6.481s；使用自有确定性协议，不是M。 |
| `platform/test/instance.docker.test.ts` — `public real startup error retains stopped container and volumes, then same-session retry replaces it` | 真实启动错误持久安全状态/日志、保留卷，显式同会话重试恢复。K通过，5.769s。 |
| `platform/test/deployment.docker.test.ts` — `keeps every used credential and marked conversation out of deployed audit rows and platform logs while covering all declared audit events` | 真实操作后19事件/4停止原因与actor/target正确；22凭据、2标记不在45行完整原始审计和214条完整日志中。D/K通过；K单项203.561s。 |
| 同文件 — `serves native HTTPS and WSS behind an exact trusted TLS proxy with Secure cookies and client audit identity` | 实际TLS/WSS、Secure属性、可信代理来源及伪造转发头拒绝；不是浏览器渲染或任意代理配置保证。D/K通过；K单项15.314s。 |
| `platform/test/first-use.docker.test.ts` — `gives untouched employees automatic work Sessions and preserves employee state on volume reuse` | 真实DSH浏览器只安装平台cookie，经认证网关进入；原生令牌/cookie留服务端。K通过。U另覆盖平台账号/管理员界面、权限失效、确认及安全错误显示。 |

共用模型密钥在实例内可读是D7已接受取舍；RAGFlow密钥不适用此例外。日志扫描是本次完整原文扫描，不是对任意编码、内存或所有未来请求的保密证明。

## 残余风险与签结条件

| 项目 | 已知事实 / 当前处置 |
| --- | --- |
| [#226 Docker DELETE长尾](https://github.com/DankerMu/dsh-team/issues/226) | 历史DELETE约9751.876ms后被总退休约10003.708ms期限取消；daemon之后是否完成、内部阶段及根因未知。后续成功不能否定该历史失败。保持10秒整体期限、身份fence、失败不假报成功、保卷，不添加retry或force-remove；保留needs-triage，阶段发布须显式风险处置。 |
| [#242 模型退休观察差异](https://github.com/DankerMu/dsh-team/issues/242) | 历史观察差异未归因；后来独立退休成功不构成根因修复。 |
| [#245 网络集成超时](https://github.com/DankerMu/dsh-team/issues/245)、[#250 上传负控提前关闭](https://github.com/DankerMu/dsh-team/issues/250) | 未修改相关源码/判据；后续通过只是不复现，不标记修复或删除失败证据。 |
| [#252 审计夹具停止期限包络](https://github.com/DankerMu/dsh-team/issues/252) | P2：30秒Docker停止grace被15秒调用期限包住，假设慢排空可误报失败；当前运行通过，不能误接受。审查明确后续，不缩短grace或放宽exit0。 |
| 人工白盒审查 | `platform/src/orchestrator/`、`images/seccomp/`、`images/dsh-user/`及规则变更仍需项目方逐行审查。AI审查、CI及运行成功不能代签；Epic末提交集中清单与证据。 |
| 最终版本证据 | #105旧候选8b6eb167的check、D2/K2通过，但M2整体失败。诊断修复PR255的审查、D3/K3及CI已通过并合并；本分支接入该修复，仍待新的精确SHA单次模型授权与最终门禁。结果文档提交不是新运行，禁止借历史M覆盖M2或提前合并签结。 |

阶段2/3及目标机Ubuntu22.04/生产模型/完全离线/容量的未执行项保留在原计划，不计为阶段1绿色结果。共享OpenSpec仅在所有阶段1签结条件满足后归档。
