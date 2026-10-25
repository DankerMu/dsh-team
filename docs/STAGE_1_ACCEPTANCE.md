# 阶段 1 验收对照

## 范围与结论

本页是任务19.8的证据索引，不重新定义需求。权威顺序为[需求基线](REQUIREMENTS_BASELINE.md)第7节、[原任务书](DSH_Enterprise_Requirements_Standalone.md)第十五节、[实施计划](IMPLEMENTATION_PLAN.md)阶段1完成条件；部署步骤见[DEPLOY](DEPLOY.md)。

阶段1范围：验收1、2、13；验收3仅“不配置个人模型密钥即可完成真实工具调用”；验收12仅“停止或重建后恢复文件与Session”及已验证的故障边界。Office、离线交付、生产模型复验和目标机容量不在本阶段完成声明内。

**当前状态：阶段1自动验收及全部子任务已完成，按项目方接受的残余风险归档。** 2026-10-26在main `a7500ce`上刷新了非模型证据（D5/K5）；下文的人工功能验收尚未执行，结果以对应验收issue记录为准。 最终行为验收绑定`1d9899c01f0e578e23d9e921d6248f60c135e5e1`，不把结果文档提交冒充新的模型运行。关键路径人工白盒审查按项目方决定统一后置，[集中清单已交付](https://github.com/DankerMu/dsh-team/issues/3#issuecomment-6209883508)，未代签；#226等历史未知原因仍保留。

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
| C4/D4/K4 | 最终候选check及原始deploy/完整Docker | check2216单元/1190集成；deploy11/11，377.88s；Docker30文件89/89，963.69s；Linux oracle66/66；全部exit0 | `1d9899c01f0e578e23d9e921d6248f60c135e5e1`；[运行及独立清理](https://github.com/DankerMu/dsh-team/pull/253#issuecomment-6209339467)、[CI38857893998](https://github.com/DankerMu/dsh-team/actions/runs/38857893998) |
| M3 | 用户再次明确授权的一次完整真实模型验收，受限Actions→giap-vps | **2/2通过，278.46s，exit0**；managed-model232.523s，Yolo44.660s；截图已检查、浏览器错误0、全部能力与资源独立退休 | 同一`1d9899c`；[Actions38857887963](https://github.com/DankerMu/dsh-team/actions/runs/38857887963)、[原生结果与退休证据](https://github.com/DankerMu/dsh-team/pull/253#issuecomment-6209739380)；授权已耗尽，无自动重试 |
| D5/K5 | 人工验收前的证据刷新：受信custody下原始完整 `pnpm test:docker`，及同一检出的原始 `pnpm test:deploy`，giap-vps Linux amd64 | Docker33文件110/110，1240.59s，custody `passed`、cleanup `confirmed`；deploy12/12，294.00s；独立观测739个登记目标全部不存在，自有库存为空，daemon/docker0/外部容器不变；全部exit0 | main `a7500ce557b3d7a907f21bd68a1316874423a28d`（#347合并）；[main CI40222865448](https://github.com/DankerMu/dsh-team/actions/runs/40222865448)；本地证据 `.run/stage1/main-a7500ce/`；无外部模型调用 |

D/K均由父级在四席审查后从精确Git归档执行，Node24.13.1、pnpm10.34.6、Docker29.1.3；前后独立自有容器、卷、网络、测试镜像库存及活动unit为空。M的一次性临时GitHub凭据、SSH能力、工作目录、锁、Docker资源与unit也独立确认退休。测试替身不会计入M。

M2整体失败及其证据继续保留，不能被M的旧成功或M3的新成功改写为通过。其复合oracle没有各子条件的单独事实，不能追溯归因为命令改写、工具名、调用身份或时序；[#254](https://github.com/DankerMu/dsh-team/issues/254)保留该历史不确定性。PR255只补充五个固定布尔诊断，保留原完全相等/身份/时序判据；M3在该诊断版本上真实通过，但不是历史失败根因修复。

D5/K5只刷新阶段1签结之后合入main的验证与测试设施改动（#336–#347）上的非模型证据，不改写D4/K4与M3的绑定，也不代表在新SHA上重跑模型。D4/K4与M3是最终行为验收批次，下列所有D/K测试在D4/K4原始完整发现中也通过；表内旧单项耗时保留为K批次的可追溯值，不混用为K4测量。PR253已合并为`1e6ee9abf79d4ef0fdb29ff66f14c754cedcb706`，[main CI38863518826](https://github.com/DankerMu/dsh-team/actions/runs/38863518826)通过并验证Docker证据的squash树等价复用；不声称在合并SHA又运行模型。

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
| `platform/test/deployment-isolation.model.test.ts` — `keeps all five deployed isolation boundaries when the real B Agent executes the canonical probes in Yolo` | 真正B Agent以Yolo执行同一五边界矩阵，原生调用/结果及A后状态关联，不靠模型口头总结。最终M3通过44.660s，两次规范探针、零审批与浏览器错误；历史M2失败128.856s保留，不归因。 |

此隔离不等于默认阻断实例访问整个内网，也不提供共用模型密钥对员工的保密隔离；这两项是已记录的产品边界，不是遗漏的通过项。DSH源码未修改；插件受管策略及真实执行入口的证明另见K中的权限/办公委派测试。

### 验收3（本阶段）：员工不配置个人密钥即可真实调用工具

| 测试文件 / 测试名 | 证明与最近结果 |
| --- | --- |
| `platform/test/managed-model.model.test.ts` — `lets a fresh employee use the administrator model to create exact workspace bytes without personal model settings` | 管理员HTTP保存模型配置、新员工真实登录与原生任务；文件事前不存在、模型工具实际生成精确字节。还包含手动writer与自然语言委派DOCX、原生子Session构造结果与最终五字段解析。最终M3单项通过232.523s；不是测试预写文件、模拟provider或完成文本证明。 |

开发模型与生产`qwen3.6`的复验、无公网任务交付按基线留阶段3。M2与M3各使用独立明确授权的一次完整执行，两次授权均已耗尽；后续模型调用必须再次明确授权并通过受限Actions通道执行，不能自动重试或将历史运行绑定为新头。

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

## 人工功能验收

自动验收证明的是测试断言。本节给项目方提供一份人工核对清单：在一套真实部署上，用浏览器亲自操作阶段1的交付功能。范围与上文一致，即验收1、2、13，验收3和12中属于本阶段的部分。Office、RAGFlow、离线交付、生产模型和目标机容量不在本阶段范围内。

人工验收不替代上面的自动验收批次，也不替代后置的关键路径白盒审查。每次验收时，把部署所用的提交SHA，以及每一项的结果（通过、不通过或备注）记录在对应的验收issue里。不通过的项保留截图和时间点，另开issue处理；不要为了让它通过而修改环境。

### 准备

1. 一套按[DEPLOY](DEPLOY.md)第1–5节部署的环境，提交为已审查的main SHA。
2. 准备以下账号：
   - 管理员账号：在真实终端里用 `admin create` 创建，密码只在隐藏提示里输入。
   - 两个员工邮箱：A 和 B。
   - 两个浏览器环境：不同浏览器，或一个普通窗口加一个无痕窗口，保证A、B的cookie互不干扰。
3. 管理员在 `/_platform/admin/models` 填写真实模型地址、密钥、模型名和默认模型。员工不需要配置任何模型信息。
4. 管理员在 `/_platform/admin/runtime` 确认空闲回收分钟数、资源上限、并发上限和默认权限档。验收期间如果需要观察空闲回收，可以临时把分钟数调小，结束后恢复。

### 验收1：两个账号使用不同实例和私有存储

| # | 操作 | 期望结果 |
|---|---|---|
| 1.1 | A、B分别在 `/_platform/register` 注册，然后登录 | 各自经等待页进入原生中文工作台，无首次公告，可以直接输入；不需要设置工作区 |
| 1.2 | A新建任务，要求Agent在工作区创建 `a-only.txt` 并写入一段指定文字 | Agent实际调用写文件工具；A的文件区能看到该文件，内容一致 |
| 1.3 | B打开自己的文件区和会话列表 | 看不到 `a-only.txt`，也看不到A的会话；B自己新建的会话和文件同样不出现在A那边 |
| 1.4 | 管理员打开 `/_platform/admin/instances` | A、B各有一个独立实例，状态为运行中，邮箱对应正确 |

### 验收2：越界访问被阻止

| # | 操作 | 期望结果 |
|---|---|---|
| 2.1 | 复制A某个会话页的完整地址，在B的浏览器里打开 | 进入B自己的工作台，A的会话内容不出现 |
| 2.2 | B访问 `/_platform/admin` 和 `/_platform/admin/instances` | 显示无权限，不显示任何账号或实例数据 |
| 2.3 | B新建任务并选择Yolo档，要求Agent用bash依次执行：访问 `/var/run/docker.sock`；查找A的文件（A的数据不应挂载在B内）；用实例页显示的A主机名访问其3080端口；覆盖写 `/managed/patch.yml` | 每一项都失败或被拒绝，失败须出现在Agent实际的工具结果里，而不只是Agent的口头描述；B仍能正常读写自己的 `/data/work` |
| 2.4 | 未登录状态下直接访问站点根路径和任意 `/_platform/api/admin/...` 接口 | 页面跳转到登录页；接口返回401，不返回数据 |

说明：内网其他地址默认可以访问，共用的模型密钥在实例内可读。这两点是已记录的产品边界（DEPLOY第7节），不按失败处理。

### 验收3（本阶段部分）：员工不配置密钥即可真实调用工具

| # | 操作 | 期望结果 |
|---|---|---|
| 3.1 | B在不打开任何模型设置的情况下，要求Agent生成一份含指定标题和三条要点的DOCX，保存到工作区 | Agent实际调用工具生成文件；在工作区下载后，用Word或WPS打开，标题和要点与要求一致 |
| 3.2 | B在新任务中手动选择“公文与材料写作”预设，给出标题、主送、事项、落款和日期，要求起草通知 | 生成的DOCX包含这五项信息 |
| 3.3 | 管理员在模型页把密钥改成错误值并保存（不重启实例），B继续工作 | 正在运行的实例不受影响；管理员重启B实例后才生效。验收完毕立即改回正确密钥 |

### 验收12（本阶段部分）：停止或重建后恢复文件与Session

| # | 操作 | 期望结果 |
|---|---|---|
| 12.1 | 管理员在实例页重启A实例（需确认） | A的页面断开后重新进入工作台，原会话和完整历史、`a-only.txt` 都还在；B不受影响 |
| 12.2 | 运维对平台容器发送SIGTERM，等待其正常退出，再用同一Compose命令 `up -d` 重新创建（不动员工容器） | 平台恢复后，A、B刷新页面（必要时重新登录）即可回到原工作台，会话和文件都在；员工容器的ID和启动时间不变 |
| 12.3 | 空闲回收：A不做任何操作，等待超过空闲时限 | 实例页显示A已停止；审计页能查到A的实例停止事件，原因为空闲；A再次访问时经等待页重新启动，会话和文件完整 |
| 12.4 | 管理员对A执行“重置配置”（需确认，提示中写明文件和对话保留） | 实例停止且不会自动启动；A显式启动后，会话和文件仍在 |

### 验收13：失效策略、可排查、凭据不暴露

| # | 操作 | 期望结果 |
|---|---|---|
| 13.1 | B正在工作台中时，管理员在账号页禁用B | B的页面连接在数秒内断开；B用原密码登录被拒绝；B的实例被停止 |
| 13.2 | 管理员重新启用B，B登录并启动实例 | 原会话和文件都在；启用不会自动启动实例 |
| 13.3 | 管理员为A重置密码 | A原有会话失效，旧密码不能登录，新密码可以登录 |
| 13.4 | A在账号设置页修改密码，然后退出登录 | 修改后当前会话仍可用；退出后回到登录页 |
| 13.5 | 管理员打开 `/_platform/admin/audit`，按事件类型、邮箱和时间筛选 | 能看到本次验收产生的注册、登录、禁用/启用、重置密码、模型配置、重启、停止等事件，操作者和对象正确；不显示对话内容或密码 |
| 13.6 | 在A、B的浏览器开发者工具中查看cookie和本地存储 | 站点cookie只有平台会话 `platform_session`（HttpOnly）；cookie和本地存储中都不出现DSH启动令牌或模型密钥 |
| 13.7 | 管理员在模型页查看配置 | 密钥只显示“已配置”，不回显明文 |
| 13.8 | 运维用 `docker compose ... logs platform` 检查验收时段的平台日志 | 日志中不出现密码、cookie值、模型密钥或对话正文 |
| 13.9 | 出错实例的排查：在实例页展开出错实例 | 显示保存的安全错误摘要和时间；如果本次验收没有出现出错实例，记为“未触发” |

### 验收结束

按[DEPLOY第8节](DEPLOY.md#8-停止与一次性验收清理)清理本次验收资源；如果要保留环境继续使用，则在验收issue中注明。常驻验收环境占用固定平台名 `dsh-team-platform`，在它运行期间，giap-vps 上的 `pnpm test:deploy` 和完整 `pnpm test:docker` 会拒绝运行。需要对其他PR做VPS验证时，先按第8节停掉这套环境。

## 残余风险与签结条件

| 项目 | 已知事实 / 当前处置 |
| --- | --- |
| [#226 Docker DELETE长尾](https://github.com/DankerMu/dsh-team/issues/226) | 历史DELETE约9751.876ms后被总退休约10003.708ms期限取消；daemon之后是否完成、内部阶段及根因未知。项目方于2026-10-16明确选择“保留已知风险，完成归档”，接受其为独立开放后续，不宣称修复。保持10秒整体期限、身份fence、失败不假报成功、保卷，不添加retry或force-remove；后续成功不能否定该历史失败。 |
| [#242 模型退休观察差异](https://github.com/DankerMu/dsh-team/issues/242) | 历史观察差异未归因；后来独立退休成功不构成根因修复。 |
| [#245 网络集成超时](https://github.com/DankerMu/dsh-team/issues/245)、[#250 上传负控提前关闭](https://github.com/DankerMu/dsh-team/issues/250) | 未修改相关源码/判据；后续通过只是不复现，不标记修复或删除失败证据。 |
| [#252 审计夹具停止期限包络](https://github.com/DankerMu/dsh-team/issues/252) | P2：30秒Docker停止grace被15秒调用期限包住，假设慢排空可误报失败；当前运行通过，不能误接受。审查明确后续，不缩短grace或放宽exit0。 |
| 人工白盒审查 | `platform/src/orchestrator/`、`images/seccomp/`、`images/dsh-user/`及规则变更仍需项目方逐行审查。按“先完成issue与PR、统一后置审查”的决定，[75项关键路径/规则PR及另列安全探针清单](https://github.com/DankerMu/dsh-team/issues/3#issuecomment-6209883508)已交付；#108用户已确认审查，其余未代签。 |
| 最终版本证据 | 同一冻结候选1d9899c的check、D4/K4、M3和CI全部通过，106个标记Part of #3的issue均关闭。该结果文档与OpenSpec归档不改变运行时、测试或判据，不冒充另一SHA的模型执行；保留M2失败、#254历史未知及其他开放后续。 |

阶段2/3及目标机Ubuntu22.04/生产模型/完全离线/容量的未执行项保留在原计划，不计为阶段1绿色结果。共享OpenSpec仅在所有阶段1签结条件满足后归档。
