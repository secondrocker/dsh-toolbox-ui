# Commands 管理设计与实施计划

用户已确认：集成 dsh-toolbox-ui；全局提示词正文、按工作区启停；官方 ctx.commands.register；数据位于 ~/.dsh/commands；迁移 ship-dev，不执行发布。

## 设计

- Commands 独立管理页：命令名称、说明、参数提示、正文，新增/编辑/删除，按规范化工作区绝对路径启停。新增默认不启用。
- 命令注册到精确 agent 作用域，不注册全局占位命令。禁用工作区不能发现或执行。拒绝覆盖内置/其他插件同名命令，显示注册诊断。
- 仅提示词执行，不支持用户 JavaScript、shell eval。参数按文本替换 $ARGUMENTS；不自动执行正文。
- ~/.dsh/commands/registry.json 维护元数据、启用工作区、revision；content/<稳定ID>-<正文摘要>.md 存不可变正文，registry 原子提交作为生效点，失败保留原版。资源放 resources/。
- 修改以 revision 乐观锁与文件锁串行提交，禁止路径注入、重复名、符号链接写入、损坏配置静默清空。编辑共享正文提示影响全部启用工作区；删除确认。
- 动态注册随配置变更协调全部活跃 agent；随 agent 创建/恢复/CWD 变更协调；销毁和插件卸载清理 disposer。handler 执行时复核工作区授权。
- 使用官方 agent 输入提交接口让正文成为接收会话的用户消息，保留沙箱、审批与现有执行边界。忙碌/取消按官方生命周期处理。
- 不启动替代 GUI。安装需通过当前 profile 插件管理能力，按实际构建/刷新结果验证既有 URL。

## 计划

1. 核对安装版 commands 注册/注销、agent prompt 提交及作用域契约。
2. 先写持久化和 runtime 失败测试，覆盖 CRUD、并发、损坏、作用域、冲突、动态协调和卸载。
3. 实现独立 store/runtime，接入现有宿主 gateway 与 RPC manifest。
4. 增加 Commands UI、双语文案、构建生成和 UI/契约测试。
5. 运行相关及全量测试、contract/client check，审查安装版兼容。
6. 迁移 ship-dev 和 11 项目表到 ~/.dsh；保留旧 .claude 文件，默认不执行任何 Git 发布。
7. 安装当前 profile，验证宿主和现有 GUI；不能验证的部分明确报告。

预计 1–2 天；不创建 OpenSpec；本设计已在对话获确认，不再重复审阅关卡。
