## ADDED Requirements

### Requirement: 外部 Document Server 失效时的提示

平台不探测管理员填写的外部 Document Server 地址。实例经实例网络接入 Document Server 时（非 published-loopback），地址不可达、拒绝连接或应答的不是 Document Server，本次启动的 ONLYOFFICE 插件照常启用，「Office 不可用时的退路」不适用。员工在 Session 中打开 DOCX、XLSX、PPTX 时 MUST 在有限等待后看到 ONLYOFFICE 插件的打开失败提示（「打开失败」及 `dsh-sidebar-onlyoffice` 的一条失败说明），MUST NOT 停在空白页或一直显示「正在打开 ONLYOFFICE …」；原文件 MUST 不变，实例的聊天和文件操作 MUST 照常可用。外部 Document Server 若带商业许可，其连接上限和满员时的提示由该 Document Server 自身处理，容量由运营方负责，本项目 MUST NOT 另加满员提示。可达的 Document Server 因 JWT 不符、版本不兼容或编辑器内部出错而显示的界面，属于 Document Server 或插件自身的行为，本要求不作承诺。

#### Scenario: 外部 Document Server 拒绝连接时打开 DOCX

- **WHEN** 管理员在后台把 Office 切到外部 Document Server，填写一个在实例内拒绝连接的地址和 JWT，员工实例重启后在 Session 中从文件区打开一个 DOCX
- **THEN** 员工在有限等待后看到「打开失败」和「无法加载 ONLYOFFICE 编辑器脚本」，不是空白页，也不再显示「正在打开 ONLYOFFICE …」；该 DOCX 的内容不变，聊天输入框可用，文件区仍列出该文件
